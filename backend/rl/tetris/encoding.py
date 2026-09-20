"""候補手の結果（置いた後の局面）をニューラルネットの入力ベクトルにする。

特徴量を増減したら **新しいバージョンを足す**こと（既存のバージョンは変えない）。
古いチェックポイントは、保存された `feature_version` に対応するエンコーダで読み込まれるので、
そのまま遊べる（`model.py` の `load_checkpoint`）。

| バージョン | 次元 | 中身 |
|---|---|---|
| 1 | 43 | 自分の盤面だけ |
| 2 | 52 | 1 に「相手の様子」9 個を足したもの（docs/TETRIS_OPPONENT_AWARE.md） |
"""

from __future__ import annotations

import numpy as np

from games.tetris import PIECE_TYPES, SPIN_FULL, SPIN_MINI, VISIBLE_HEIGHT
from games.tetris.features import board_features

from .position import Candidate, OpponentView

FEATURE_VERSION = 2

_SELF_NAMES: list[str] = (
    [f"height_{x}" for x in range(10)]
    + [
        "holes", "hole_rows", "hole_depth", "bumpiness", "max_height", "agg_height",
        "row_transitions", "col_transitions", "wells", "t_slots",
        "lines", "attack", "spin_full", "spin_mini", "perfect_clear",
        "combo", "b2b", "pending_garbage",
    ]
    + [f"hold_{p}" for p in PIECE_TYPES] + ["hold_none"]
    + [f"next_{p}" for p in PIECE_TYPES]
)

# 相手の様子。盤面そのものではなく「どれだけ追い詰められているか」を渡す。
# opp_present が無いと「相手がいない」と「相手の盤面が空（＝相手が絶好調）」を区別できない。
_OPPONENT_NAMES: list[str] = [
    "opp_present", "opp_max_height", "opp_agg_height", "opp_holes", "opp_bumpiness",
    "opp_pending", "opp_margin", "opp_combo", "opp_b2b",
]

FEATURE_NAMES_BY_VERSION: dict[int, list[str]] = {
    1: _SELF_NAMES,
    2: _SELF_NAMES + _OPPONENT_NAMES,
}
FEATURE_DIMS: dict[int, int] = {v: len(n) for v, n in FEATURE_NAMES_BY_VERSION.items()}

FEATURE_NAMES = FEATURE_NAMES_BY_VERSION[FEATURE_VERSION]
FEATURE_DIM = FEATURE_DIMS[FEATURE_VERSION]

# だいたい 0〜1 に収まるようにするための割り算の値
_SELF_SCALE = (
    [20.0] * 10
    + [20, 20, 40, 40, 20, 200, 60, 60, 60, 3, 4, 10, 1, 1, 1, 10, 1, 20]
    + [1] * 8 + [1] * 7
)
_OPPONENT_SCALE = [1, 20, 200, 20, 40, 20, 20, 10, 1]

_SCALE_BY_VERSION: dict[int, np.ndarray] = {
    1: np.array(_SELF_SCALE, dtype=np.float32),
    2: np.array(_SELF_SCALE + _OPPONENT_SCALE, dtype=np.float32),
}


def _self_values(c: Candidate) -> list:
    f = board_features(c.outcome.board)
    o = c.outcome
    v = list(f.heights) + [
        f.holes, f.hole_rows, f.hole_depth, f.bumpiness, f.max_height, f.agg_height,
        f.row_transitions, f.col_transitions, f.wells, f.t_slots,
        o.lines, o.attack, c.placement.spin == SPIN_FULL, c.placement.spin == SPIN_MINI,
        o.perfect_clear, max(o.combo, 0), o.b2b, sum(p[0] for p in o.pending),
    ]
    v += [c.hold_after == p for p in PIECE_TYPES] + [c.hold_after is None]
    v += [c.next_after == p for p in PIECE_TYPES]
    return v


def _opponent_values(opp: OpponentView | None) -> list:
    """相手がいなければ全部 0（opp_present = 0）。"""
    if opp is None:
        return [0] * len(_OPPONENT_NAMES)
    # あと何段で相手が死ぬか。計算で出せる値だが、判断の中心になるので直接渡す
    margin = max(0, VISIBLE_HEIGHT - (opp.max_height + opp.pending))
    return [
        1, opp.max_height, opp.agg_height, opp.holes, opp.bumpiness,
        opp.pending, margin, max(opp.combo, 0), opp.b2b,
    ]


def encode(c: Candidate, version: int = FEATURE_VERSION) -> np.ndarray:
    v = _self_values(c)
    if version >= 2:
        # 「この手を打った後」の相手を見る。送った段数が相手の保留に乗るので、
        # 「この手で相手を倒しきれる」が価値にあらわれる
        v += _opponent_values(c.opponent_after())
    return np.asarray(v, dtype=np.float32) / _SCALE_BY_VERSION[version]


def encode_many(cands: list[Candidate], version: int = FEATURE_VERSION) -> np.ndarray:
    if not cands:
        return np.zeros((0, FEATURE_DIMS[version]), dtype=np.float32)
    return np.stack([encode(c, version) for c in cands])
