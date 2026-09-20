"""AI が判断に使う「局面」と、そこから打てる手（候補）の列挙。

学習（BlobGame から作る）と API（ブラウザから送られた JSON から作る）の両方で同じ処理を使う。

候補は 24 通り（rot 4 × 列 6）から、出たばかりの組が実際に届く置き方だけを残したもの。
「置く → 連鎖が止まるまで」までを試算するが、**予告のおじゃまは降らせない**
（降り方は乱数なので、pending を特徴量として渡して学習させる）。
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field

from games.blob import BlobGame, ChainResult, Field, Pair, SPAWN_X, SPAWN_Y, W

Colors = tuple[int, int]  # (軸の色, 子の色)


@dataclass
class Position:
    field: Field
    current: Colors
    next: list[Colors] = dc_field(default_factory=list)
    pending: int = 0
    carry: int = 0
    all_clear_bonus: bool = False

    @classmethod
    def from_game(cls, g: BlobGame) -> "Position":
        assert g.current is not None
        return cls(
            field=g.field, current=(g.current.axis, g.current.child), next=list(g.next),
            pending=g.pending, carry=g.carry, all_clear_bonus=g.all_clear_bonus,
        )

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        """API の入力（dict）から作る。形式は apps/blob_ai/serializers.py を参照。"""
        f = Field()
        for y, row in enumerate(d["rows"]):
            for x, ch in enumerate(row):
                f.set(x, y, int(ch))
        return cls(
            field=f, current=tuple(d["current"]), next=[tuple(p) for p in d.get("next", [])],
            pending=d.get("pending", 0), carry=d.get("carry", 0),
            all_clear_bonus=d.get("all_clear_bonus", False),
        )

    def game(self) -> BlobGame:
        """この局面から始まる BlobGame（試算用。盤面は共有するので clone してから使う）。"""
        return BlobGame.from_state(
            self.field, Pair(SPAWN_X, SPAWN_Y, 0, *self.current), list(self.next),
            self.pending, self.carry, self.all_clear_bonus,
        )


@dataclass
class Candidate:
    """1 つの手（どの列に、どの向きで置くか）と、その結果。"""

    x: int
    rot: int
    path: list[str]  # 出たばかりの組をそこへ動かす操作列（最後は "HD"）
    field_after: Field
    result: ChainResult
    pending_after: int
    carry_after: int
    all_clear_bonus_after: bool
    next_after: Colors | None  # この手の後に出てくる組
    queue_after: list[Colors] = dc_field(default_factory=list)
    dead: bool = False


def enumerate_candidates(pos: Position) -> list[Candidate]:
    probe = pos.game()
    if probe.current is None or not probe.can_place(probe.current):
        return []  # 出てくる場所がふさがっている = ゲームオーバーの局面
    next_after = pos.next[0] if pos.next else None
    rest = list(pos.next[1:])
    seen: set[tuple] = set()
    out: list[Candidate] = []
    for rot in range(4):
        for x in range(W):
            path = probe.path_to(x, rot)
            if path is None:
                continue
            trial = BlobGame.from_state(pos.field.clone(), probe.current, pending=pos.pending,
                                        carry=pos.carry, all_clear_bonus=pos.all_clear_bonus)
            result = trial.place(x, rot)
            key = (bytes(trial.field.cells), trial.pending, trial.carry)
            if key in seen:
                continue  # 同じ色の組など、結果が同じになる置き方は 1 つだけ残す
            seen.add(key)
            out.append(Candidate(
                x=x, rot=rot, path=path, field_after=trial.field, result=result,
                pending_after=trial.pending, carry_after=trial.carry,
                all_clear_bonus_after=trial.all_clear_bonus,
                next_after=next_after, queue_after=rest,
                dead=not trial.field.free(SPAWN_X, SPAWN_Y),
            ))
    return out


def position_after(c: Candidate) -> Position | None:
    """手 c を打った後の局面（次の組が出た状態）。死ぬ手・次の組が分からないときは None。

    先読み用なので、予告のおじゃまが降るぶんは見ていない。
    """
    if c.dead or c.next_after is None:
        return None
    return Position(
        field=c.field_after, current=c.next_after, next=c.queue_after, pending=c.pending_after,
        carry=c.carry_after, all_clear_bonus=c.all_clear_bonus_after,
    )
