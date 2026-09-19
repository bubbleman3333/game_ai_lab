"""T-Spin 判定と火力計算。盤面を持たない純粋関数だけを置く（AI の先読みでも使う）。"""

from __future__ import annotations

from dataclasses import dataclass

from .board import Board
from .pieces import T_ALL_CORNERS, T_FRONT_CORNERS

SPIN_NONE = "none"
SPIN_MINI = "mini"
SPIN_FULL = "full"

GARBAGE_CAP_PER_LOCK = 8
PERFECT_CLEAR_BONUS = 10
COMBO_TABLE = (0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5)
_NORMAL_ATTACK = (0, 0, 1, 2, 4)
_TSPIN_ATTACK = (0, 2, 4, 6)
_MINI_ATTACK = (0, 0, 1)


def detect_spin(board: Board, piece: str, rot: int, x: int, y: int, last_kick: int | None) -> str:
    """固定直前の盤面で T-Spin かどうかを判定する。

    last_kick: 最後に成功した操作が回転ならその kick 番号（0..4）、そうでなければ None。
    """
    if piece != "T" or last_kick is None:
        return SPIN_NONE
    filled = sum(board.is_filled(x + dx, y + dy) for dx, dy in T_ALL_CORNERS)
    if filled < 3:
        return SPIN_NONE
    front = sum(board.is_filled(x + dx, y + dy) for dx, dy in T_FRONT_CORNERS[rot])
    if front == 2 or last_kick == 4:
        return SPIN_FULL
    return SPIN_MINI


@dataclass(frozen=True)
class AttackResult:
    attack: int
    combo: int  # 更新後の combo（消さなければ -1）
    b2b: bool  # 更新後の B2B 継続状態
    b2b_bonus: bool  # 今回 B2B ボーナスが付いたか


def compute_attack(lines: int, spin: str, combo: int, b2b: bool, perfect_clear: bool) -> AttackResult:
    if lines == 0:
        # 列を消さない T-Spin は B2B を切らない。通常の置きも B2B は維持。
        return AttackResult(0, -1, b2b, False)

    if spin == SPIN_FULL:
        base = _TSPIN_ATTACK[min(lines, 3)]
    elif spin == SPIN_MINI:
        base = _MINI_ATTACK[min(lines, 2)]
    else:
        base = _NORMAL_ATTACK[lines]

    difficult = lines == 4 or spin != SPIN_NONE
    b2b_bonus = difficult and b2b
    new_combo = combo + 1
    attack = base + (1 if b2b_bonus else 0) + COMBO_TABLE[min(new_combo, len(COMBO_TABLE) - 1)]
    if perfect_clear:
        attack += PERFECT_CLEAR_BONUS
    return AttackResult(attack, new_combo, difficult, b2b_bonus)


def cancel_garbage(pending: list[list[int]], attack: int) -> tuple[list[list[int]], int]:
    """火力で予告を相殺する。戻り値は (残った予告, 相手に送る段数)。

    pending は [段数, 穴の列] のリスト（古い順）。元のリストは変更しない。
    """
    remaining = [list(p) for p in pending]
    while attack > 0 and remaining:
        take = min(attack, remaining[0][0])
        remaining[0][0] -= take
        attack -= take
        if remaining[0][0] == 0:
            remaining.pop(0)
    return remaining, attack
