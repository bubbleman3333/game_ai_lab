"""ミノを固定したときの処理（消去・火力・相殺・せり上がり）。

Game と AI の先読み（シミュレーション）の両方がこの関数を使うので、結果は必ず一致する。
"""

from __future__ import annotations

from dataclasses import dataclass

from .board import Board
from .rules import GARBAGE_CAP_PER_LOCK, cancel_garbage, compute_attack


@dataclass
class LockOutcome:
    board: Board  # 固定・消去・せり上がり後の盤面（入力とは別オブジェクト）
    lines: int
    attack: int
    sent: int
    combo: int
    b2b: bool
    b2b_bonus: bool
    perfect_clear: bool
    pending: list[list[int]]
    garbage_received: int
    dead: bool  # top out（せり上がりで押し出された）。出現できるか（block out）は呼び出し側で確認


def resolve_lock(
    board: Board, piece: str, rot: int, x: int, y: int, spin: str,
    combo: int, b2b: bool, pending: list[list[int]],
) -> LockOutcome:
    b = board.copy()
    b.place(piece, rot, x, y)
    lines = b.clear_lines()
    perfect = lines > 0 and b.is_empty()
    atk = compute_attack(lines, spin, combo, b2b, perfect)
    remaining, sent = cancel_garbage(pending, atk.attack)

    received, top_out = 0, False
    if lines == 0:
        remaining, received, top_out = apply_pending_garbage(b, remaining)

    return LockOutcome(
        board=b, lines=lines, attack=atk.attack, sent=sent, combo=atk.combo, b2b=atk.b2b,
        b2b_bonus=atk.b2b_bonus, perfect_clear=perfect, pending=remaining,
        garbage_received=received, dead=top_out,
    )


def apply_pending_garbage(board: Board, pending: list[list[int]]) -> tuple[list[list[int]], int, bool]:
    """予告を最大 GARBAGE_CAP_PER_LOCK 段まで盤面に入れる（board を直接変更する）。

    戻り値: (残りの予告, 入れた段数, top out したか)
    """
    remaining = [list(p) for p in pending]
    received = 0
    while remaining and received < GARBAGE_CAP_PER_LOCK:
        amount, hole = remaining[0]
        n = min(amount, GARBAGE_CAP_PER_LOCK - received)
        received += n
        if n == amount:
            remaining.pop(0)
        else:
            remaining[0][0] -= n
        if not board.add_garbage(n, hole):
            return remaining, received, True
    return remaining, received, False
