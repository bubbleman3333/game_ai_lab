"""レース AI のニューラルネット（方策と価値）と、ブラウザ用の書き出し。

方策 π(行動 | 観測): 観測 30 個 → 行動 3 個（アクセル・ステア・ジャンプ、それぞれ -1〜1）の平均。
    学習中は平均のまわりに正規分布でばらつかせて試し（探索）、レースでは平均をそのまま使う。
価値 V(観測): この状況から先にもらえる報酬の予想（PPO の学習に使う。ブラウザには送らない）。

観測の中身は games/racer/physics.py の observe() を見ること。
観測か行動の形を変えたら POLICY_VERSION を上げる（古い重みは読めなくなる）。
"""

from __future__ import annotations

import json
from pathlib import Path

import torch
from torch import nn

from games.racer.physics import OBS_DIM

ACT_DIM = 3
POLICY_VERSION = 1


def _mlp(in_dim: int, out_dim: int, hidden: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Linear(in_dim, hidden), nn.Tanh(),
        nn.Linear(hidden, hidden), nn.Tanh(),
        nn.Linear(hidden, out_dim),
    )


class ActorCritic(nn.Module):
    def __init__(self, hidden: int = 256):
        super().__init__()
        self.hidden = hidden
        self.actor = _mlp(OBS_DIM, ACT_DIM, hidden)
        self.critic = _mlp(OBS_DIM, 1, hidden)
        self.log_std = nn.Parameter(torch.full((ACT_DIM,), -0.5))

    def dist(self, obs: torch.Tensor) -> torch.distributions.Normal:
        return torch.distributions.Normal(self.actor(obs), self.log_std.exp().expand(obs.shape[0], ACT_DIM))

    def value(self, obs: torch.Tensor) -> torch.Tensor:
        return self.critic(obs).squeeze(-1)

    @torch.no_grad()
    def act(self, obs: torch.Tensor, deterministic: bool = False) -> torch.Tensor:
        """-1〜1 に収めた行動。"""
        mean = self.actor(obs)
        a = mean if deterministic else torch.normal(mean, self.log_std.exp().expand_as(mean))
        return a.clamp(-1, 1)


EXPORT_DIGITS = 6  # ブラウザへ配る重みの桁数


def export_json(model: ActorCritic, path: Path, meta: dict) -> None:
    """ブラウザで動かすため、方策（actor）の重みだけを JSON にする。

    重みは小数 6 桁に丸める。ネットは float32 なので元の精度はもともと 7 桁ほどしかなく、
    丸めても走りは変わらない。丸めないと JSON が 1.6MB を超えて、ブラウザの読み込みが重くなる。
    """
    def r(x):
        return [r(v) for v in x] if isinstance(x, list) else round(x, EXPORT_DIGITS)

    layers = [m for m in model.actor if isinstance(m, nn.Linear)]
    data = {
        "version": POLICY_VERSION,
        "activation": "tanh",
        "layers": [{"w": r(l.weight.detach().cpu().tolist()), "b": r(l.bias.detach().cpu().tolist())}
                   for l in layers],
        "meta": meta,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def save(model: ActorCritic, path: Path, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    torch.save({"state_dict": model.state_dict(), "hidden": model.hidden,
                "version": POLICY_VERSION, "meta": meta}, tmp)
    tmp.replace(path)


def load(path: Path, device: str = "cpu") -> tuple[ActorCritic, dict]:
    data = torch.load(path, map_location=device, weights_only=False)
    if data.get("version") != POLICY_VERSION:
        raise ValueError(f"{path} は古い形式です（version {data.get('version')}）")
    model = ActorCritic(data["hidden"]).to(device)
    model.load_state_dict(data["state_dict"])
    return model, data.get("meta", {})
