"""盤面。1 行を 10bit の整数で持つ（bit x = 列 x）。y=0 が最下段。"""

from __future__ import annotations

from .pieces import BOARD_HEIGHT, BOARD_WIDTH, SHAPES

FULL_ROW = (1 << BOARD_WIDTH) - 1


class Board:
    __slots__ = ("rows",)

    def __init__(self, rows: list[int] | None = None):
        self.rows: list[int] = list(rows) if rows is not None else [0] * BOARD_HEIGHT

    def copy(self) -> "Board":
        return Board(self.rows)

    # --- 参照 ---------------------------------------------------------------
    def is_filled(self, x: int, y: int) -> bool:
        """盤外（左右の壁・床）は埋まっているものとして扱う。"""
        if x < 0 or x >= BOARD_WIDTH or y < 0:
            return True
        if y >= BOARD_HEIGHT:
            return False
        return (self.rows[y] >> x) & 1 == 1

    def collides(self, piece: str, rot: int, x: int, y: int) -> bool:
        shape = SHAPES[piece][rot]
        left = x + shape.min_dx
        if left < 0 or x + shape.max_dx >= BOARD_WIDTH or y + shape.min_dy < 0:
            return True
        rows = self.rows
        for dy, mask in shape.row_masks:
            yy = y + dy
            if yy < BOARD_HEIGHT and rows[yy] & (mask << left):
                return True
        return False

    def is_empty(self) -> bool:
        return not any(self.rows)

    # --- 変更 ---------------------------------------------------------------
    def place(self, piece: str, rot: int, x: int, y: int) -> None:
        shape = SHAPES[piece][rot]
        left = x + shape.min_dx
        for dy, mask in shape.row_masks:
            self.rows[y + dy] |= mask << left

    def clear_lines(self) -> int:
        kept = [r for r in self.rows if r != FULL_ROW]
        cleared = BOARD_HEIGHT - len(kept)
        if cleared:
            self.rows = kept + [0] * cleared
        return cleared

    def add_garbage(self, lines: int, hole: int) -> bool:
        """下から lines 段せり上げる。上から押し出されたら False（top out）。"""
        overflow = any(self.rows[BOARD_HEIGHT - lines:])
        row = FULL_ROW & ~(1 << hole)
        self.rows = [row] * lines + self.rows[: BOARD_HEIGHT - lines]
        return not overflow

    # --- 表示・デバッグ用 -----------------------------------------------------
    def to_strings(self, height: int = 20) -> list[str]:
        """上の行から順に '#'/'.' の文字列。print でそのまま見られる。"""
        return [
            "".join("#" if (self.rows[y] >> x) & 1 else "." for x in range(BOARD_WIDTH))
            for y in range(height - 1, -1, -1)
        ]

    def __repr__(self) -> str:
        return "\n".join(self.to_strings())
