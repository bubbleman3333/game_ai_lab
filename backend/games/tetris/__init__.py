"""テトリスのルールエンジン（Django に依存しない純粋な Python パッケージ）。

入口:
    Game            1 人分のゲーム（操作・固定・せり上がり）
    find_placements AI 用の置き場所探索
    resolve_lock    固定の結果を計算（Game と AI の先読みで共通）
仕様は docs/RULES.md。
"""

from .board import Board
from .game import ACTIONS, ActivePiece, Game, LockResult, Stats
from .lock import LockOutcome, resolve_lock
from .movegen import Placement, find_placements
from .pieces import BOARD_HEIGHT, BOARD_WIDTH, PIECE_TYPES, VISIBLE_HEIGHT
from .rules import SPIN_FULL, SPIN_MINI, SPIN_NONE

__all__ = [
    "ACTIONS", "ActivePiece", "Board", "Game", "LockOutcome", "LockResult", "Placement",
    "Stats", "find_placements", "resolve_lock", "BOARD_HEIGHT", "BOARD_WIDTH",
    "PIECE_TYPES", "VISIBLE_HEIGHT", "SPIN_FULL", "SPIN_MINI", "SPIN_NONE",
]
