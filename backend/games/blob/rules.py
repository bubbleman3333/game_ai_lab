"""ブロブチェインのルール（TypeScript 版 frontend/src/games/blob/engine/rules.ts と同じ動きにする）。

時間（落下・アニメーション）は扱わない。盤面・組ぷよ・得点・乱数だけ。

盤面: 幅 6、高さ 13（y=0 が一番下。y=12 は画面外の 13 段目で、ここにある粒は消えない）。
組ぷよ（2 個 1 組）: 軸 (x, y) と子。rot 0 = 子が上、1 = 右、2 = 下、3 = 左。
"""

from __future__ import annotations

from dataclasses import dataclass, replace

W = 6
H = 13
VISIBLE_H = 12
SPAWN_X = 2
SPAWN_Y = 11  # この位置がふさがると負け（左から 3 列目・上から 2 段目）
EMPTY = 0
GARBAGE = 5
COLORS = 4
POP_COUNT = 4
TARGET_POINT = 70  # 何点で 1 個おじゃまを送るか
ALL_CLEAR_BONUS = 30  # 全消しした次の連鎖に上乗せするおじゃまの数
MAX_GARBAGE_DROP = 30  # 1 回に降るおじゃまの上限（5 段）

# 連鎖ボーナス（1 連鎖目から）・色数ボーナス・連結ボーナス（ぷよぷよ通と同じ計算）
CHAIN_POWER = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512]
COLOR_BONUS = [0, 0, 3, 6, 12, 24]

CHILD_OFFSET = [(0, 1), (1, 0), (0, -1), (-1, 0)]

# マスの隣（上下左右）を毎回作り直さずに済むように先に作っておく
_NEIGHBORS: list[tuple[int, ...]] = []
for _i in range(W * H):
    _x, _y = _i % W, _i // W
    _NEIGHBORS.append(tuple(
        ny * W + nx
        for nx, ny in ((_x + 1, _y), (_x - 1, _y), (_x, _y + 1), (_x, _y - 1))
        if 0 <= nx < W and 0 <= ny < VISIBLE_H
    ))


def group_bonus(n: int) -> int:
    return 0 if n <= 4 else 10 if n >= 11 else n - 3


@dataclass(frozen=True)
class Pair:
    """組ぷよ。axis が軸の色、child が子の色（どちらも 1〜4）。"""

    x: int
    y: int
    rot: int
    axis: int
    child: int

    def moved(self, **kw) -> "Pair":
        return replace(self, **kw)


def child_pos(p: Pair) -> tuple[int, int]:
    dx, dy = CHILD_OFFSET[p.rot]
    return p.x + dx, p.y + dy


class Field:
    """盤面。cells[y * W + x] に色（0 = 空き、1〜4 = 色、5 = おじゃま）。"""

    __slots__ = ("cells",)

    def __init__(self, cells: bytearray | None = None):
        self.cells = cells if cells is not None else bytearray(W * H)

    def get(self, x: int, y: int) -> int:
        if x < 0 or x >= W or y < 0:
            return -1  # 壁と床
        if y >= H:
            return EMPTY
        return self.cells[y * W + x]

    def set(self, x: int, y: int, v: int) -> None:
        if 0 <= x < W and 0 <= y < H:
            self.cells[y * W + x] = v

    def free(self, x: int, y: int) -> bool:
        return self.get(x, y) == EMPTY

    def is_empty(self) -> bool:
        return not any(self.cells)

    def clone(self) -> "Field":
        return Field(bytearray(self.cells))

    def height(self, x: int) -> int:
        """列 x に積まれている高さ（重力をかけた後は下から詰まっている）。"""
        h = 0
        while h < H and self.cells[h * W + x]:
            h += 1
        return h

    def heights(self) -> list[int]:
        return [self.height(x) for x in range(W)]

    def apply_gravity(self) -> list[tuple[int, int, int]]:
        """浮いている粒を下に落とす。戻り値は動いた粒の (x, 元の y, 新しい y)。"""
        moved: list[tuple[int, int, int]] = []
        cells = self.cells
        for x in range(W):
            write = 0
            for y in range(H):
                v = cells[y * W + x]
                if v == EMPTY:
                    continue
                if y != write:
                    cells[write * W + x] = v
                    cells[y * W + x] = EMPTY
                    moved.append((x, y, write))
                write += 1
        return moved

    def find_pops(self) -> tuple[list[list[int]], list[int]]:
        """消える粒のまとまり（見えている段だけ・4 個以上）と、巻き込まれて消えるおじゃま。"""
        cells = self.cells
        seen = bytearray(W * H)
        groups: list[list[int]] = []
        for i in range(W * VISIBLE_H):
            c = cells[i]
            if c < 1 or c > COLORS or seen[i]:
                continue
            group = [i]
            seen[i] = 1
            stack = [i]
            while stack:
                j = stack.pop()
                for k in _NEIGHBORS[j]:
                    if not seen[k] and cells[k] == c:
                        seen[k] = 1
                        stack.append(k)
                        group.append(k)
            if len(group) >= POP_COUNT:
                groups.append(group)
        garbage: list[int] = []
        hit = bytearray(W * H)
        for g in groups:
            for j in g:
                for k in _NEIGHBORS[j]:
                    if cells[k] == GARBAGE and not hit[k]:
                        hit[k] = 1
                        garbage.append(k)
        return groups, garbage


def can_place(field: Field, p: Pair) -> bool:
    """組ぷよ p をその場所に置けるか（壁・床・ほかの粒にぶつからないか）。"""
    cx, cy = child_pos(p)
    return field.free(p.x, p.y) and field.free(cx, cy) and p.y < H and cy < H


def pop_once(field: Field, chain: int) -> tuple[list[tuple[int, int]], int] | None:
    """消えるものがあれば 1 段分だけ消す（重力はまだかけない）。戻り値は (消えた (マス, 色), 得点)。

    BlobGame.pop_step と「連鎖が何段組めるか」の見積り（rl/blob/encoding.py）で共通に使う。
    """
    groups, garbage = field.find_pops()
    if not groups:
        return None
    cells = [(i, field.cells[i]) for i in [*(j for g in groups for j in g), *garbage]]
    score = chain_score(groups, lambda g: field.cells[g[0]], chain)
    for i, _ in cells:
        field.cells[i] = 0
    return cells, score


def simulate_chain(field: Field) -> tuple[int, int, int]:
    """連鎖が止まるまで進める（field は書き換わる）。戻り値は (連鎖数, 消えた数, 得点)。"""
    chain = popped = score = 0
    while True:
        step = pop_once(field, chain + 1)
        if step is None:
            return chain, popped, score
        cells, s = step
        chain += 1
        popped += len(cells)
        score += s
        field.apply_gravity()


def chain_score(groups: list[list[int]], color_of, chain: int) -> int:
    """1 回の消去（連鎖の 1 段）の得点。chain は 1 から。"""
    popped = sum(len(g) for g in groups)
    colors = len({color_of(g) for g in groups})
    bonus = (
        CHAIN_POWER[min(chain - 1, len(CHAIN_POWER) - 1)]
        + COLOR_BONUS[min(colors, len(COLOR_BONUS) - 1)]
        + sum(group_bonus(len(g)) for g in groups)
    )
    return 10 * popped * min(999, max(1, bonus))


class Rng:
    """mulberry32。TypeScript 版の Rng と同じ値を同じ順番で返す。"""

    __slots__ = ("s",)

    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFF

    def next(self) -> float:
        # JavaScript の Math.imul（32bit の掛け算）は「掛けて下位 32bit を取る」と同じ
        self.s = (self.s + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = ((t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF) ^ t
        return (t ^ (t >> 14)) / 4294967296

    def int(self, n: int) -> int:
        return int(self.next() * n)
