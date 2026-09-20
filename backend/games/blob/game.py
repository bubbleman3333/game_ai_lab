"""1 人分のブロブチェインの状態と操作（TypeScript 版 engine/game.ts と同じ動き）。

時間に関わること（落下の速さ・アニメーション）はブラウザ側 (controller.ts) の担当で、ここにはない。
学習・AI は「置く場所を決めて lock() → resolve()」という使い方をする。
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field

from .rules import (
    ALL_CLEAR_BONUS, COLORS, Field, GARBAGE, H, MAX_GARBAGE_DROP, Pair, Rng, SPAWN_X, SPAWN_Y, TARGET_POINT, W,
    can_place, child_pos, pop_once,
)


@dataclass
class PopStep:
    """連鎖の 1 段分の結果。"""

    chain: int
    cells: list[tuple[int, int]]  # (マス番号, 色)
    score: int
    attack: int  # この段で生まれたおじゃま（相殺前）
    cancelled: int  # 自分に来ていたおじゃまを打ち消した数
    sent: int  # 相手に送る数

    def to_dict(self) -> dict:
        return {"chain": self.chain, "score": self.score, "attack": self.attack,
                "cancelled": self.cancelled, "sent": self.sent, "cells": [list(c) for c in self.cells]}


@dataclass
class ChainResult:
    """1 手ぶんの連鎖のまとめ（lock の後に resolve() で一気に処理した結果）。"""

    chain: int = 0
    popped: int = 0
    score: int = 0
    attack: int = 0
    cancelled: int = 0
    sent: int = 0
    all_clear: bool = False
    steps: list[PopStep] = dc_field(default_factory=list)


@dataclass
class Stats:
    pairs: int = 0
    sent: int = 0
    all_clears: int = 0


class BlobGame:
    def __init__(self, seed: int = 0):
        self.field = Field()
        self.current: Pair | None = None
        self.score = 0
        self.chain = 0
        self.max_chain = 0
        self.pending = 0  # 相手から届いて、まだ降っていないおじゃま
        self.carry = 0  # 70 点に満たずに余った得点（次の消去に持ち越す）
        self.all_clear_bonus = False
        self.over = False
        self.stats = Stats()
        self._rng = Rng(seed)
        self._garbage_rng = Rng(seed ^ 0x5BD1E995)
        self._queue: list[tuple[int, int]] = []
        self._fill()
        self.spawn()

    @classmethod
    def from_state(cls, field: Field, current: Pair | None, next_pairs: list[tuple[int, int]] | None = None,
                   pending: int = 0, carry: int = 0, all_clear_bonus: bool = False) -> "BlobGame":
        """盤面と組を指定して作る（AI の「この手を打ったらどうなるか」の試算用）。

        乱数は使わないので、next_pairs に入れた組だけが出てくる（足りなくなったら
        spawn() で IndexError になるため、先読みの深さぶんだけ渡すこと）。
        """
        g = cls.__new__(cls)
        g.field = field
        g.current = current
        g.score = 0
        g.chain = 0
        g.max_chain = 0
        g.pending = pending
        g.carry = carry
        g.all_clear_bonus = all_clear_bonus
        g.over = False
        g.stats = Stats()
        g._rng = Rng(0)
        g._garbage_rng = Rng(0)
        g._queue = list(next_pairs or [])
        return g

    def _fill(self) -> None:
        while len(self._queue) < 3:
            self._queue.append((1 + self._rng.int(COLORS), 1 + self._rng.int(COLORS)))

    @property
    def next(self) -> list[tuple[int, int]]:
        """次と、その次の組。"""
        return self._queue[:2]

    def spawn(self) -> bool:
        axis, child = self._queue.pop(0)
        self._fill()
        if not self.field.free(SPAWN_X, SPAWN_Y):
            self.over = True
            self.current = None
            return False
        self.current = Pair(SPAWN_X, SPAWN_Y, 0, axis, child)
        return True

    def can_place(self, p: Pair) -> bool:
        return can_place(self.field, p)

    # --- 操作 --------------------------------------------------------------------------
    def move(self, dx: int) -> bool:
        p = self.current
        if p is None:
            return False
        q = p.moved(x=p.x + dx)
        if not self.can_place(q):
            return False
        self.current = q
        return True

    def rotate(self, direction: int) -> bool:
        """+1 で右回転、-1 で左回転。壁や粒にぶつかるときは軸を押し出す。"""
        p = self.current
        if p is None:
            return False
        rot = (p.rot + direction) % 4
        q = p.moved(rot=rot)
        if self.can_place(q):
            self.current = q
            return True
        # 押し出し: 子が行く向きと反対へ軸を 1 マスずらす
        cx, cy = child_pos(q)
        kicked = q.moved(x=q.x - (cx - q.x), y=q.y - (cy - q.y))
        if self.can_place(kicked):
            self.current = kicked
            return True
        # 左右が両方ふさがっているとき（縦のまま回せない）は上下を入れ替える
        if rot in (1, 3):
            flip = p.moved(rot=(p.rot + 2) % 4)
            if self.can_place(flip):
                self.current = flip
                return True
            up = flip.moved(y=flip.y + 1)
            if self.can_place(up):
                self.current = up
                return True
        return False

    def soft_drop(self) -> bool:
        """1 マス下へ。下がれなければ False（接地）。"""
        p = self.current
        if p is None:
            return False
        q = p.moved(y=p.y - 1)
        if not self.can_place(q):
            return False
        self.current = q
        return True

    def is_grounded(self) -> bool:
        p = self.current
        return p is not None and not self.can_place(p.moved(y=p.y - 1))

    def landing_y(self) -> int:
        """着地する位置（ゴースト表示用）。"""
        p = self.current
        assert p is not None
        y = p.y
        while self.can_place(p.moved(y=y - 1)):
            y -= 1
        return y

    def hard_drop(self) -> int:
        """接地するまで落とす。戻り値は落ちたマス数。"""
        n = 0
        while self.soft_drop():
            n += 1
        return n

    def path_to(self, x: int, rot: int) -> list[str] | None:
        """出たばかりの組を (x, rot) まで動かす操作列。届かないときは None。

        回転してから左右に動かす。実際に組を動かして確かめるので、押し出し（キック）で
        位置がずれてしまう置き方や、高く積まれて通れない置き方は None になる。
        ブラウザ側もこの操作列をそのまま実行する（apps/blob_ai）。
        """
        p = self.current
        if p is None:
            return None
        actions = ["CCW"] if rot == 3 else ["CW"] * rot
        try:
            for a in actions:
                self.rotate(1 if a == "CW" else -1)
            q = self.current
            ok = q.rot == rot and q.x == p.x and q.y == p.y
            while ok and self.current.x != x:
                dx = 1 if x > self.current.x else -1
                if not self.move(dx):
                    ok = False
                    break
                actions.append("R" if dx > 0 else "L")
            ok = ok and self.current.x == x
        finally:
            self.current = p  # 調べただけなので元に戻す
        return actions + ["HD"] if ok else None

    # --- 固定と連鎖 -------------------------------------------------------------------
    def lock(self) -> list[tuple[int, int, int]]:
        """今の組をその場に置き、ちぎれた粒を落とす。"""
        p = self.current
        assert p is not None
        cx, cy = child_pos(p)
        self.field.set(p.x, p.y, p.axis)
        self.field.set(cx, cy, p.child)
        self.current = None
        self.chain = 0
        self.stats.pairs += 1
        return self.field.apply_gravity()

    def pop_step(self) -> PopStep | None:
        """消えるものがあれば 1 段分消して得点・おじゃまを計算する（重力はまだかけない）。"""
        step = pop_once(self.field, self.chain + 1)
        if step is None:
            return None
        cells, score = step
        self.chain += 1
        self.max_chain = max(self.max_chain, self.chain)
        self.score += score

        points = score + self.carry
        attack = points // TARGET_POINT
        self.carry = points % TARGET_POINT
        if self.all_clear_bonus:
            attack += ALL_CLEAR_BONUS
            self.all_clear_bonus = False
        cancelled = min(self.pending, attack)
        self.pending -= cancelled
        sent = attack - cancelled
        self.stats.sent += sent
        return PopStep(self.chain, cells, score, attack, cancelled, sent)

    def settle(self) -> bool:
        """消えた後に重力をかける。全消しになったら True（次の連鎖にボーナス）。"""
        self.field.apply_gravity()
        all_clear = self.field.is_empty()
        if all_clear:
            self.all_clear_bonus = True
            self.stats.all_clears += 1
        return all_clear

    def resolve(self) -> ChainResult:
        """lock の後、連鎖が止まるまで一気に処理する（アニメーションのない学習・AI 用）。"""
        r = ChainResult()
        while True:
            step = self.pop_step()
            if step is None:
                break
            r.steps.append(step)
            r.chain = step.chain
            r.popped += len(step.cells)
            r.score += step.score
            r.attack += step.attack
            r.cancelled += step.cancelled
            r.sent += step.sent
            if self.settle():
                r.all_clear = True
        return r

    def place(self, x: int, rot: int) -> ChainResult:
        """今の組を (x, rot) に置いて連鎖まで済ませる。置けないときは ValueError。"""
        p = self.current
        if p is None:
            raise ValueError("操作中の組がありません")
        self.current = p.moved(x=x, rot=rot)
        if not self.can_place(self.current):
            self.current = p
            raise ValueError(f"({x}, rot={rot}) には置けません")
        self.hard_drop()
        self.lock()
        return self.resolve()

    # --- おじゃま -----------------------------------------------------------------------
    def receive_garbage(self, n: int) -> None:
        if n > 0:
            self.pending += n

    def drop_garbage(self) -> list[int]:
        """予告のおじゃまを降らせる（最大 30 個）。戻り値は置いたマス。"""
        n = min(self.pending, MAX_GARBAGE_DROP)
        if n <= 0:
            return []
        self.pending -= n
        per_col = [n // W] * W
        # 端数はランダムな別々の列に
        cols = list(range(W))
        for k in range(n % W):
            j = k + self._garbage_rng.int(W - k)
            cols[k], cols[j] = cols[j], cols[k]
            per_col[cols[k]] += 1
        placed: list[int] = []
        for x in range(W):
            y = 0
            while y < H and not self.field.free(x, y):
                y += 1
            for _ in range(per_col[x]):
                if y >= H:
                    break
                self.field.set(x, y, GARBAGE)
                placed.append(y * W + x)
                y += 1
        return placed

    # --- 1 手ぶんをまとめて進める（学習用） ----------------------------------------------
    def step(self, x: int, rot: int) -> ChainResult:
        """(x, rot) に置く → 連鎖 → 予告のおじゃまが降る → 次の組が出る。"""
        result = self.place(x, rot)
        self.drop_garbage()
        self.spawn()
        return result

    # --- 保存・読み込み ------------------------------------------------------------------
    def snapshot(self) -> dict:
        """TypeScript 版と突き合わせるための状態（fixtures で使う）。"""
        return {
            "cells": list(self.field.cells),
            "score": self.score,
            "max_chain": self.max_chain,
            "pending": self.pending,
            "carry": self.carry,
            "all_clear_bonus": self.all_clear_bonus,
            "over": self.over,
            "stats": {"pairs": self.stats.pairs, "sent": self.stats.sent, "all_clears": self.stats.all_clears},
            "current": None if self.current is None else
            [self.current.x, self.current.y, self.current.rot, self.current.axis, self.current.child],
            "next": [list(p) for p in self.next],
        }
