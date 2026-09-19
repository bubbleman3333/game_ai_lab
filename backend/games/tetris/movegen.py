"""置ける場所を全部探す（AI 用）。

出現位置から L / R / CW / CCW / SDB（床まで落とす）で幅優先探索し、
床に接した状態を「置き場所」として集める。回転で入り込む T-Spin の位置も見つかる。
返す path をそのまま Game.apply() に渡して最後に HD すれば、同じ場所に固定される。
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from .board import Board
from .pieces import SHAPES, SPAWN_X, SPAWN_Y, kicks
from .rules import detect_spin


@dataclass(frozen=True)
class Placement:
    piece: str
    rot: int
    x: int
    y: int
    spin: str
    path: tuple[str, ...]  # HD の直前までの操作列（HOLD を含むことがある）

    def cells(self) -> list[tuple[int, int]]:
        return [(self.x + dx, self.y + dy) for dx, dy in SHAPES[self.piece][self.rot].cells]

    def to_dict(self) -> dict:
        return {
            "piece": self.piece, "rot": self.rot, "x": self.x, "y": self.y,
            "spin": self.spin, "path": list(self.path),
        }


def _drop_y(board: Board, piece: str, rot: int, x: int, y: int) -> int:
    while not board.collides(piece, rot, x, y - 1):
        y -= 1
    return y


def find_placements(board: Board, piece: str) -> list[Placement]:
    """piece を出現位置から動かして置ける場所をすべて返す（同じ形・同じ spin は 1 つにまとめる）。"""
    if board.collides(piece, 0, SPAWN_X, SPAWN_Y):
        return []

    results: dict[tuple, Placement] = {}
    shapes = SHAPES[piece]

    def record(x: int, y: int, rot: int, path: tuple[str, ...], kick: int | None) -> None:
        if not board.collides(piece, rot, x, y - 1):
            return  # まだ宙に浮いている
        spin = detect_spin(board, piece, rot, x, y, kick)
        s = shapes[rot]
        # 同じマスを占める置き方（回転違いの S/Z/I/O など）は 1 つにまとめる
        key = (s.form, x + s.min_dx, y + s.min_dy, spin)
        if key not in results:
            results[key] = Placement(piece, rot, x, y, spin, path)

    start = (SPAWN_X, SPAWN_Y, 0)
    visited: dict[tuple[int, int, int], tuple[str, ...]] = {start: ()}
    queue = deque([start])
    record(*start, (), None)

    while queue:
        x, y, rot = queue.popleft()
        path = visited[(x, y, rot)]
        successors: list[tuple[str, int, int, int, int | None]] = []

        for act, dx in (("L", -1), ("R", 1)):
            if not board.collides(piece, rot, x + dx, y):
                successors.append((act, x + dx, y, rot, None))
        for act, d in (("CW", 1), ("CCW", -1)):
            to_rot = (rot + d) % 4
            for i, (kx, ky) in enumerate(kicks(piece, rot, to_rot)):
                if not board.collides(piece, to_rot, x + kx, y + ky):
                    successors.append((act, x + kx, y + ky, to_rot, i))
                    break
        dy = _drop_y(board, piece, rot, x, y)
        if dy != y:
            successors.append(("SDB", x, dy, rot, None))

        for act, nx, ny, nrot, kick in successors:
            new_path = path + (act,)
            record(nx, ny, nrot, new_path, kick)
            state = (nx, ny, nrot)
            if state not in visited:
                visited[state] = new_path
                queue.append(state)

    return list(results.values())
