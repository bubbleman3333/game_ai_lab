"""将棋 AI のニューラルネット（方策と価値の 2 つの頭を持つ ResNet）。dlshogi と同じ入出力の形。

入力: cshogi.dlshogi.make_input_features が作る 2 種類の特徴（どちらも 9×9 の面の重なり）
    features1: 盤上の駒と利き（FEATURES1_NUM 面）
    features2: 持ち駒の数・王手かどうか（FEATURES2_NUM 面。盤全体に同じ値）
出力:
    方策: 次の一手の確率（27 方向 × 81 マス = 2187 通りの「指し手ラベル」の logits）
    価値: 手番側が勝つ確率（0〜1 の手前の logit）
"""

from __future__ import annotations

from pathlib import Path

import torch
from cshogi.dlshogi import FEATURES1_NUM, FEATURES2_NUM
from torch import nn
from torch.nn import functional as F

MOVE_DIRECTIONS = 27
POLICY_SIZE = MOVE_DIRECTIONS * 81
MODEL_VERSION = 1


class ResBlock(nn.Module):
    def __init__(self, ch: int):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = F.relu(self.b1(self.c1(x)))
        h = self.b2(self.c2(h))
        return F.relu(x + h)


class PolicyValueNet(nn.Module):
    def __init__(self, blocks: int = 10, channels: int = 128):
        super().__init__()
        self.blocks_n, self.channels = blocks, channels
        self.in1 = nn.Conv2d(FEATURES1_NUM, channels, 3, padding=1, bias=False)
        self.in2 = nn.Conv2d(FEATURES2_NUM, channels, 1, bias=False)
        self.in_bn = nn.BatchNorm2d(channels)
        self.blocks = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        # 方策: 各マスについて 27 方向ぶんの点数
        self.policy = nn.Conv2d(channels, MOVE_DIRECTIONS, 1, bias=False)
        self.policy_bias = nn.Parameter(torch.zeros(POLICY_SIZE))
        # 価値
        self.v_conv = nn.Conv2d(channels, MOVE_DIRECTIONS, 1, bias=False)
        self.v_bn = nn.BatchNorm2d(MOVE_DIRECTIONS)
        self.v_fc1 = nn.Linear(POLICY_SIZE, 256)
        self.v_fc2 = nn.Linear(256, 1)

    def forward(self, f1: torch.Tensor, f2: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        x = F.relu(self.in_bn(self.in1(f1) + self.in2(f2)))
        x = self.blocks(x)
        policy = self.policy(x).flatten(1) + self.policy_bias
        v = F.relu(self.v_bn(self.v_conv(x))).flatten(1)
        value = self.v_fc2(F.relu(self.v_fc1(v))).squeeze(-1)
        return policy, value


def save(model: PolicyValueNet, path: Path, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    torch.save({"state_dict": model.state_dict(), "blocks": model.blocks_n, "channels": model.channels,
                "version": MODEL_VERSION, "meta": meta}, tmp)
    tmp.replace(path)


def load(path: Path, device: str | torch.device = "cpu") -> tuple[PolicyValueNet, dict]:
    data = torch.load(path, map_location=device, weights_only=False)
    if data.get("version") != MODEL_VERSION:
        raise ValueError(f"{path} は古い形式です")
    model = PolicyValueNet(data["blocks"], data["channels"]).to(device)
    model.load_state_dict(data["state_dict"])
    model.eval()
    return model, data.get("meta", {})
