"""AI が判断に使う「局面」と、そこから打てる手（候補）の列挙。

学習（Game から作る）と API（ブラウザから送られた JSON から作る）の両方で同じ処理を使う。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from games.tetris import Board, Game, Placement, find_placements, resolve_lock
from games.tetris.lock import LockOutcome
from games.tetris.pieces import SPAWN_X, SPAWN_Y


@dataclass
class Position:
    board: Board
    current: str
    hold: str | None
    can_hold: bool
    next: list[str]
    combo: int = -1
    b2b: bool = False
    pending: list[list[int]] = field(default_factory=list)

    @classmethod
    def from_game(cls, g: Game) -> "Position":
        assert g.current is not None
        return cls(
            board=g.board, current=g.current.type, hold=g.hold_piece, can_hold=g.can_hold,
            next=g.next_pieces, combo=g.combo, b2b=g.b2b, pending=[list(p) for p in g.pending],
        )

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        """API の入力（snake_case の dict）から作る。形式は apps/ai/serializers.py を参照。"""
        return cls(
            board=Board(d["rows"]), current=d["current"], hold=d.get("hold"),
            can_hold=d.get("can_hold", True), next=list(d.get("next", [])),
            combo=d.get("combo", -1), b2b=d.get("b2b", False),
            pending=[list(p) for p in d.get("pending", [])],
        )


@dataclass
class Candidate:
    """1 つの手（ホールドするか + どこに置くか）と、その結果。"""

    placement: Placement
    use_hold: bool
    outcome: LockOutcome
    hold_after: str | None
    next_after: str | None  # この手の後に出てくるミノ
    dead: bool
    queue_after: list[str] = field(default_factory=list)  # next_after より後のツモ（先読み用）

    @property
    def path(self) -> list[str]:
        return (["HOLD"] if self.use_hold else []) + list(self.placement.path) + ["HD"]


def enumerate_candidates(pos: Position) -> list[Candidate]:
    options: list[tuple[bool, str, str | None, list[str]]] = [(False, pos.current, pos.hold, pos.next)]
    if pos.can_hold:
        if pos.hold is None:
            if pos.next:
                options.append((True, pos.next[0], pos.current, pos.next[1:]))
        elif pos.hold != pos.current:
            options.append((True, pos.hold, pos.current, pos.next))

    result: list[Candidate] = []
    for use_hold, piece, hold_after, queue in options:
        next_after = queue[0] if queue else None
        rest = list(queue[1:])
        for pl in find_placements(pos.board, piece):
            out = resolve_lock(pos.board, pl.piece, pl.rot, pl.x, pl.y, pl.spin, pos.combo, pos.b2b, pos.pending)
            dead = out.dead or (
                next_after is not None and out.board.collides(next_after, 0, SPAWN_X, SPAWN_Y)
            )
            result.append(Candidate(pl, use_hold, out, hold_after, next_after, dead, rest))
    return result


def position_after(c: Candidate) -> Position | None:
    """手 c を打った後の局面（次のミノが出た状態）。死ぬ手・次のミノが分からないときは None。"""
    if c.dead or c.next_after is None:
        return None
    o = c.outcome
    return Position(
        board=o.board, current=c.next_after, hold=c.hold_after, can_hold=True, next=c.queue_after,
        combo=o.combo, b2b=o.b2b, pending=[list(p) for p in o.pending],
    )
