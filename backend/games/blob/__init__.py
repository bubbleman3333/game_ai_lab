"""ブロブチェインのルールエンジン（純粋な Python。Django に依存しない）。

TypeScript 版は frontend/src/games/blob/engine/。ルールを変えたら両方直し、
python -m games.blob.fixtures でテストデータを作り直すこと。
"""

from .game import BlobGame, ChainResult, PopStep, Stats
from .rules import (
    ALL_CLEAR_BONUS, COLORS, EMPTY, GARBAGE, H, MAX_GARBAGE_DROP, POP_COUNT, SPAWN_X, SPAWN_Y, TARGET_POINT,
    VISIBLE_H, W, Field, Pair, Rng, chain_score, child_pos,
)

__all__ = [
    "BlobGame", "ChainResult", "PopStep", "Stats",
    "Field", "Pair", "Rng", "chain_score", "child_pos",
    "W", "H", "VISIBLE_H", "SPAWN_X", "SPAWN_Y", "EMPTY", "GARBAGE", "COLORS", "POP_COUNT",
    "TARGET_POINT", "ALL_CLEAR_BONUS", "MAX_GARBAGE_DROP",
]
