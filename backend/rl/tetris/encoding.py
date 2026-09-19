"""候補手の結果（置いた後の局面）をニューラルネットの入力ベクトルにする。

特徴量を増減したら FEATURE_VERSION を上げること。古いチェックポイントは読み込み時にエラーになる。
"""

from __future__ import annotations

import numpy as np

from games.tetris import PIECE_TYPES, SPIN_FULL, SPIN_MINI
from games.tetris.features import board_features

from .position import Candidate

FEATURE_VERSION = 1

FEATURE_NAMES: list[str] = (
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
FEATURE_DIM = len(FEATURE_NAMES)

# だいたい 0〜1 に収まるようにするための割り算の値
_SCALE = np.array(
    [20.0] * 10
    + [20, 20, 40, 40, 20, 200, 60, 60, 60, 3, 4, 10, 1, 1, 1, 10, 1, 20]
    + [1] * 8 + [1] * 7,
    dtype=np.float32,
)


def encode(c: Candidate) -> np.ndarray:
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
    return np.asarray(v, dtype=np.float32) / _SCALE


def encode_many(cands: list[Candidate]) -> np.ndarray:
    if not cands:
        return np.zeros((0, FEATURE_DIM), dtype=np.float32)
    return np.stack([encode(c) for c in cands])
