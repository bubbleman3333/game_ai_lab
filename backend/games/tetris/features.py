"""盤面の特徴量（穴・高さ・凸凹など）。AI の入力やテスト用ヒューリスティックで使う。"""

from __future__ import annotations

from dataclasses import dataclass

from .board import Board
from .pieces import BOARD_WIDTH, SHAPES, VISIBLE_HEIGHT
from .rules import SPIN_FULL, detect_spin

FULL_ROW = (1 << BOARD_WIDTH) - 1


@dataclass(frozen=True)
class BoardFeatures:
    heights: tuple[int, ...]  # 各列の高さ（10 個）
    holes: int  # 上が埋まっている空きマスの数
    hole_rows: int  # 穴がある行の数
    hole_depth: int  # 穴の上に積まれているブロック数の合計
    bumpiness: int  # 隣り合う列の高さの差の合計
    max_height: int
    agg_height: int
    row_transitions: int  # 横方向に 空き/埋まり が切り替わる回数
    col_transitions: int  # 縦方向の切り替わり回数
    wells: int  # 両隣より低い列の深さの合計（1+2+...+d）
    t_slots: int  # T-Spin Double ができる穴の数


def board_features(board: Board) -> BoardFeatures:
    rows = board.rows
    top = VISIBLE_HEIGHT + 4
    heights = [0] * BOARD_WIDTH
    for y in range(top - 1, -1, -1):
        r = rows[y]
        if not r:
            continue
        for x in range(BOARD_WIDTH):
            if heights[x] == 0 and (r >> x) & 1:
                heights[x] = y + 1

    holes = hole_rows = hole_depth = 0
    for y in range(max(heights)):
        r = rows[y]
        row_has_hole = False
        for x in range(BOARD_WIDTH):
            if not (r >> x) & 1 and heights[x] > y:
                holes += 1
                row_has_hole = True
                hole_depth += sum((rows[yy] >> x) & 1 for yy in range(y + 1, heights[x]))
        hole_rows += row_has_hole

    bump = sum(abs(heights[i] - heights[i + 1]) for i in range(BOARD_WIDTH - 1))
    max_h = max(heights)

    row_tr = 0
    for y in range(max_h):
        # 左右の壁は埋まっている扱い
        r = rows[y] | (1 << BOARD_WIDTH)
        prev = 1
        for x in range(BOARD_WIDTH + 1):
            cur = (r >> x) & 1
            row_tr += cur != prev
            prev = cur

    col_tr = 0
    for x in range(BOARD_WIDTH):
        prev = 1  # 床
        for y in range(heights[x] + 1):
            cur = (rows[y] >> x) & 1
            col_tr += cur != prev
            prev = cur

    wells = 0
    for x in range(BOARD_WIDTH):
        left = heights[x - 1] if x > 0 else 99
        right = heights[x + 1] if x < BOARD_WIDTH - 1 else 99
        d = min(left, right) - heights[x]
        if d > 0:
            wells += d * (d + 1) // 2

    return BoardFeatures(
        heights=tuple(heights), holes=holes, hole_rows=hole_rows, hole_depth=hole_depth,
        bumpiness=bump, max_height=max_h, agg_height=sum(heights),
        row_transitions=row_tr, col_transitions=col_tr, wells=wells,
        t_slots=count_tsd_slots(board, heights),
    )


def count_tsd_slots(board: Board, heights: list[int] | None = None) -> int:
    """下向きの T を入れると T-Spin で 2 列以上消える場所の数（到達できるかは見ない簡易版）。"""
    if heights is None:
        heights = [0] * BOARD_WIDTH
        for x in range(BOARD_WIDTH):
            for y in range(VISIBLE_HEIGHT + 3, -1, -1):
                if (board.rows[y] >> x) & 1:
                    heights[x] = y + 1
                    break
    shape = SHAPES["T"][2]
    count = 0
    for x in range(1, BOARD_WIDTH - 1):
        # T の中心が入る高さの候補: 中央列の上から、左右の列の高いほうまで
        for y in range(max(1, heights[x] + 1), max(heights[x - 1], heights[x + 1]) + 1):
            if board.collides("T", 2, x, y) or not board.collides("T", 2, x, y - 1):
                continue
            if detect_spin(board, "T", 2, x, y, 0) != SPIN_FULL:
                continue
            filled = 0
            for dy, mask in shape.row_masks:
                if (board.rows[y + dy] | (mask << (x + shape.min_dx))) == FULL_ROW:
                    filled += 1
            if filled >= 2:
                count += 1
    return count
