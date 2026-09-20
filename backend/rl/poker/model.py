"""ポーカー AI のニューラルネット（PyTorch）と、推論だけの軽い numpy 版。

2 種類のネットを使う（どちらも形は同じ全結合ネット）。

- **advantage ネット**: 局面 → 各手の「後悔（その手を選んでいたらどれだけ得だったか）」の予想。
  学習中の打ち方は、この予想の正の部分に比例した確率で手を選ぶ（後悔マッチング）。
- **strategy ネット**: 局面 → 各手を選ぶ確率。**最後に遊ぶのはこちら**。
  CFR で強くなるのは「学習中の打ち方の平均」なので、それを覚えさせる係。

**なぜ numpy 版があるのか**: 木をたどる間、1 局面ずつネットを呼ぶことになる。バッチ 1 では
PyTorch も numpy も「計算そのもの」より**1 回ごとの呼び出しの手間**が支配的になる。そこで

- 層を減らし、**LayerNorm を使わない**（LayerNorm は numpy だと 1 層で 7 回も配列演算が要り、
  実測でネット 1 回 117 マイクロ秒のうち大半を占めていた）
- 行列積の置き場所を先に確保して使い回す（毎回の確保をやめる）
- BLAS のスレッド数を 1 にする（小さな行列では、スレッドを起こす手間の方が高くつく。
  16 スレッドのままだと 3 倍遅かった）

としてある。**学習は PyTorch（GPU）、木をたどるのは numpy（CPU を複数プロセス）**。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn

from .encoding import FEATURE_VERSION, N_FEATURES


class PokerNet(nn.Module):
    """全結合ネット。advantage 用と strategy 用で同じ形を使う。"""

    def __init__(self, n_actions: int, hidden: int = 256, layers: int = 3,
                 n_features: int = N_FEATURES):
        super().__init__()
        self.n_features = n_features
        self.n_actions = n_actions
        self.hidden = hidden
        self.layers = layers
        blocks: list[nn.Module] = []
        size = n_features
        for _ in range(layers):
            blocks += [nn.Linear(size, hidden), nn.ReLU()]
            size = hidden
        self.body = nn.Sequential(*blocks)
        self.head = nn.Linear(size, n_actions)
        # 最初はどの手も同じ評価にしておく（学習の出だしが安定する）
        nn.init.zeros_(self.head.weight)
        nn.init.zeros_(self.head.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.body(x))

    def to_numpy(self) -> "NumpyNet":
        """木をたどる用の軽い版に写す。"""
        layers = []
        with torch.no_grad():
            for m in list(self.body) + [self.head]:
                if isinstance(m, nn.Linear):
                    layers.append((m.weight.detach().cpu().numpy().astype(np.float32).T.copy(),
                                   m.bias.detach().cpu().numpy().astype(np.float32).copy()))
        return NumpyNet(layers, self.n_actions)

    def config(self) -> dict:
        return {
            "n_features": self.n_features,
            "n_actions": self.n_actions,
            "hidden": self.hidden,
            "layers": self.layers,
            "feature_version": FEATURE_VERSION,
        }

    def save(self, path: Path, meta: dict | None = None) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({"state_dict": self.state_dict(), "config": self.config(),
                    "meta": meta or {}}, path)

    @classmethod
    def load(cls, path: Path, device: str = "cpu") -> tuple["PokerNet", dict]:
        blob = torch.load(path, map_location=device, weights_only=False)
        cfg = blob["config"]
        if cfg.get("feature_version") != FEATURE_VERSION:
            raise ValueError(
                f"特徴量の版が違う（保存 {cfg.get('feature_version')} / 今 {FEATURE_VERSION}）。"
                "encoding.py を変えたなら学習し直しが必要"
            )
        net = cls(cfg["n_actions"], cfg["hidden"], cfg["layers"], cfg["n_features"])
        net.load_state_dict(blob["state_dict"])
        net.to(device).eval()
        return net, blob.get("meta", {})


class NumpyNet:
    """推論だけの軽い版。`PokerNet.to_numpy()` で作る。プロセス間で受け渡しできる。

    `layers` は (重み, バイアス) の並び。最後の層以外は ReLU を通す。
    置き場所（`_buf`）は最初の呼び出しで作って使い回す。
    """

    __slots__ = ("layers", "n_actions", "_buf")

    def __init__(self, layers: list, n_actions: int):
        self.layers = layers
        self.n_actions = n_actions
        self._buf: list[np.ndarray] = []

    def __getstate__(self):
        return (self.layers, self.n_actions)  # 置き場所はプロセス間で送らない

    def __setstate__(self, state):
        self.layers, self.n_actions = state
        self._buf = []

    @property
    def weights(self):
        """学習済みかどうかの判定に使う（空なら学習前）。"""
        return self.layers

    def __call__(self, x: np.ndarray) -> np.ndarray:
        if not self._buf:
            self._buf = [np.empty(b.shape, dtype=np.float32) for _, b in self.layers]
        h = x
        last = len(self.layers) - 1
        for i, (w, b) in enumerate(self.layers):
            out = self._buf[i]
            np.dot(h, w, out=out)
            out += b
            if i != last:
                np.maximum(out, 0.0, out=out)
            h = out
        return h


def zero_net(n_actions: int) -> NumpyNet:
    """学習前。どの手も評価 0（＝打てる手の等確率になる）。"""
    return NumpyNet([], n_actions)


def masked_softmax(logits: np.ndarray, mask: list[bool]) -> list[float]:
    """打てる手だけでソフトマックス。strategy ネットの出力を確率に直すのに使う。"""
    best = -np.inf
    for i, ok in enumerate(mask):
        if ok and logits[i] > best:
            best = float(logits[i])
    total = 0.0
    out = [0.0] * len(mask)
    for i, ok in enumerate(mask):
        if ok:
            v = float(np.exp(logits[i] - best))
            out[i] = v
            total += v
    if total <= 0.0:
        n = sum(mask)
        return [1.0 / n if ok else 0.0 for ok in mask]
    return [v / total for v in out]


def regret_match(advantages: np.ndarray, mask: list[bool]) -> list[float]:
    """後悔マッチング: 予想した後悔の正の部分に比例した確率。

    全部 0 以下なら**一番マシな手**を選ぶ（Deep CFR の論文と同じ扱い）。等確率にすると
    はっきり悪いと分かっている手まで混ぜてしまうため。ただし**同点のときは均等に混ぜる**。
    ここを「先に見つけた方」にすると、学習前（予想が全部 0）に必ず同じ手だけを打つ
    AI になり、木が潰れて何も学べない（実際そうなっていた）。
    """
    n = len(mask)
    out = [0.0] * n
    total = 0.0
    best_v = -np.inf
    for i in range(n):
        if not mask[i]:
            continue
        v = float(advantages[i])
        if v > 0.0:
            out[i] = v
            total += v
        if v > best_v:
            best_v = v
    if total > 0.0:
        return [v / total for v in out]
    tied = [i for i in range(n) if mask[i] and float(advantages[i]) >= best_v - 1e-9]
    share = 1.0 / len(tied)
    result = [0.0] * n
    for i in tied:
        result[i] = share
    return result
