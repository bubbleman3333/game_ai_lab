"""価値ネットワーク V(置いた後の盤面) と、チェックポイントの保存・読み込み。"""

from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

from .encoding import FEATURE_DIM, FEATURE_VERSION


class ValueNet(nn.Module):
    def __init__(self, in_dim: int = FEATURE_DIM, hidden: int = 256, layers: int = 3):
        super().__init__()
        mods: list[nn.Module] = []
        d = in_dim
        for _ in range(layers):
            mods += [nn.Linear(d, hidden), nn.ReLU()]
            d = hidden
        mods.append(nn.Linear(d, 1))
        self.net = nn.Sequential(*mods)
        self.hidden = hidden
        self.layers = layers

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


def resolve_device(name: str = "auto") -> torch.device:
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)


def save_checkpoint(path: Path, model: ValueNet, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    torch.save(
        {
            "state_dict": model.state_dict(),
            "feature_version": FEATURE_VERSION,
            "hidden": model.hidden,
            "layers": model.layers,
            "meta": meta,
        },
        tmp,
    )
    tmp.replace(path)  # 書きかけのファイルを読まれないように置き換える


def load_checkpoint(path: Path, device: str | torch.device = "cpu") -> tuple[ValueNet, dict]:
    data = torch.load(path, map_location=device, weights_only=False)
    if data.get("feature_version") != FEATURE_VERSION:
        raise ValueError(
            f"{path} は特徴量バージョン {data.get('feature_version')} 用です"
            f"（現在は {FEATURE_VERSION}）。学習し直してください。"
        )
    model = ValueNet(hidden=data["hidden"], layers=data["layers"]).to(device)
    model.load_state_dict(data["state_dict"])
    model.eval()
    return model, data.get("meta", {})
