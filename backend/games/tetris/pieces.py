"""ミノの形と SRS の壁蹴り表。座標は y が上向き（docs/RULES.md 参照）。"""

from __future__ import annotations

PIECE_TYPES: tuple[str, ...] = ("I", "J", "L", "O", "S", "T", "Z")

BOARD_WIDTH = 10
BOARD_HEIGHT = 40
VISIBLE_HEIGHT = 20
SPAWN_X = 4
SPAWN_Y = 20

Cell = tuple[int, int]


def _rotate_cw(cells: tuple[Cell, ...]) -> tuple[Cell, ...]:
    # y 上向き座標での時計回り 90°: (x, y) -> (y, -x)
    return tuple((y, -x) for x, y in cells)


def _all_rotations(spawn: tuple[Cell, ...]) -> tuple[tuple[Cell, ...], ...]:
    states = [spawn]
    for _ in range(3):
        states.append(_rotate_cw(states[-1]))
    return tuple(states)


# 回転状態 0..3 ごとのセル（原点からの相対座標）
CELLS: dict[str, tuple[tuple[Cell, ...], ...]] = {
    "T": _all_rotations(((-1, 0), (0, 0), (1, 0), (0, 1))),
    "J": _all_rotations(((-1, 1), (-1, 0), (0, 0), (1, 0))),
    "L": _all_rotations(((1, 1), (-1, 0), (0, 0), (1, 0))),
    "S": _all_rotations(((0, 1), (1, 1), (-1, 0), (0, 0))),
    "Z": _all_rotations(((-1, 1), (0, 1), (0, 0), (1, 0))),
    # O は回転しても位置が変わらない
    "O": (((0, 0), (1, 0), (0, 1), (1, 1)),) * 4,
    # I は SRS の 4x4 箱の中心 (0.5, -0.5) まわりに回る
    "I": (
        ((-1, 0), (0, 0), (1, 0), (2, 0)),
        ((1, 1), (1, 0), (1, -1), (1, -2)),
        ((-1, -1), (0, -1), (1, -1), (2, -1)),
        ((0, 1), (0, 0), (0, -1), (0, -2)),
    ),
}

# (回転前, 回転後) -> kick テスト 0..4
_KICKS_JLSTZ: dict[tuple[int, int], tuple[Cell, ...]] = {
    (0, 1): ((0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)),
    (1, 0): ((0, 0), (1, 0), (1, -1), (0, 2), (1, 2)),
    (1, 2): ((0, 0), (1, 0), (1, -1), (0, 2), (1, 2)),
    (2, 1): ((0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)),
    (2, 3): ((0, 0), (1, 0), (1, 1), (0, -2), (1, -2)),
    (3, 2): ((0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)),
    (3, 0): ((0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)),
    (0, 3): ((0, 0), (1, 0), (1, 1), (0, -2), (1, -2)),
}
_KICKS_I: dict[tuple[int, int], tuple[Cell, ...]] = {
    (0, 1): ((0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)),
    (1, 0): ((0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)),
    (1, 2): ((0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)),
    (2, 1): ((0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)),
    (2, 3): ((0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)),
    (3, 2): ((0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)),
    (3, 0): ((0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)),
    (0, 3): ((0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)),
}
_KICKS_O: dict[tuple[int, int], tuple[Cell, ...]] = {k: ((0, 0),) for k in _KICKS_JLSTZ}


def kicks(piece: str, from_rot: int, to_rot: int) -> tuple[Cell, ...]:
    table = _KICKS_I if piece == "I" else _KICKS_O if piece == "O" else _KICKS_JLSTZ
    return table[(from_rot, to_rot)]


# T-Spin 判定用: T の向きごとの「前側の 2 隅」
T_FRONT_CORNERS: dict[int, tuple[Cell, Cell]] = {
    0: ((-1, 1), (1, 1)),
    1: ((1, 1), (1, -1)),
    2: ((-1, -1), (1, -1)),
    3: ((-1, 1), (-1, -1)),
}
T_ALL_CORNERS: tuple[Cell, ...] = ((-1, 1), (1, 1), (-1, -1), (1, -1))


class Shape:
    """衝突判定を速くするため、(ミノ, 回転) ごとに行ビットマスクを前計算したもの。"""

    __slots__ = ("cells", "min_dx", "max_dx", "min_dy", "max_dy", "row_masks", "form")

    def __init__(self, cells: tuple[Cell, ...]):
        self.cells = cells
        self.min_dx = min(c[0] for c in cells)
        self.max_dx = max(c[0] for c in cells)
        self.min_dy = min(c[1] for c in cells)
        self.max_dy = max(c[1] for c in cells)
        masks: dict[int, int] = {}
        for dx, dy in cells:
            masks[dy] = masks.get(dy, 0) | (1 << (dx - self.min_dx))
        # (dy, min_dx 基準のマスク)
        self.row_masks: tuple[tuple[int, int], ...] = tuple(sorted(masks.items()))
        # 左下を原点にした形。回転が違っても同じ形なら同じ値（S/Z/I/O の重複判定に使う）
        self.form: tuple[tuple[int, int], ...] = tuple(
            sorted((dx - self.min_dx, dy - self.min_dy) for dx, dy in cells)
        )


SHAPES: dict[str, tuple[Shape, ...]] = {p: tuple(Shape(c) for c in CELLS[p]) for p in PIECE_TYPES}
