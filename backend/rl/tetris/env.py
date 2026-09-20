"""学習・評価用の環境。

- `TetrisEnv`: Game を 1 つ持ち、ランダムなおじゃまを送ってくる相手の代わりもする。
- `VersusEnv`: Game を 2 つ持ち、**本物の相手と火力を送り合う**（自己対戦の学習用）。

ランダムなおじゃまは「いつ・どれだけ来るか」が相手の状況と無関係なので、
「相手が溜めているから今は低く構える」といった判断は学びようがない。それを学ばせるための環境。
"""

from __future__ import annotations

import random

from games.tetris import Game, LockResult

from .position import Candidate, Position, enumerate_candidates


class TetrisEnv:
    def __init__(self, max_pieces: int = 1500, garbage_rate: float = 0.0, seed: int = 0):
        self.max_pieces = max_pieces
        self.garbage_rate = garbage_rate  # 1 手あたりの期待段数
        self._rng = random.Random(seed)
        self.game = Game(seed=seed)

    def reset(self, seed: int) -> None:
        self.game = Game(seed=seed)
        self._rng.seed(seed)

    @property
    def done(self) -> bool:
        return self.game.over or self.game.stats.pieces >= self.max_pieces

    @property
    def truncated(self) -> bool:
        """上限の手数に達して打ち切られた（死んではいない）。"""
        return not self.game.over and self.game.stats.pieces >= self.max_pieces

    def position(self) -> Position:
        return Position.from_game(self.game)

    def candidates(self) -> list[Candidate]:
        return enumerate_candidates(self.position())

    def step(self, c: Candidate) -> LockResult:
        g = self.game
        result: LockResult | None = None
        for a in c.path:
            r = g.apply(a)
            if a == "HD":
                result = r  # type: ignore[assignment]
        assert result is not None
        # 先読みと実際の結果がずれていたらエンジンのバグ
        assert result.lines == c.outcome.lines and result.attack == c.outcome.attack, (c.placement, result)
        self._maybe_send_garbage()
        return result

    def _maybe_send_garbage(self) -> None:
        if self.garbage_rate <= 0 or self.game.over:
            return
        # 1〜4 段（平均 2.5 段）を確率 rate/2.5 で送る → 1 手あたり平均 rate 段
        if self._rng.random() < self.garbage_rate / 2.5:
            self.game.receive_garbage(self._rng.randint(1, 4))


class VersusEnv:
    """2 人が火力を送り合う環境（自己対戦の学習用）。

    おじゃまの送り方はオンライン対戦と同じで、固定の結果の `sent`（相殺後の段数）を相手に渡す
    （`match.py` と同じ。あちらは評価用に「手を選ぶ AI」を受け取るが、こちらは学習の側が
    候補手を自分で選ぶので、1 手ずつ外から進められるようにしてある）。

    どちらのツモ順も同じ（オンライン対戦が両者に同じ seed を配るのに合わせた）。
    実際の対戦は同時に進むが、ここでは 1 手ずつ交互に打つ。
    """

    def __init__(self, max_pieces: int = 1500, seed: int = 0):
        self.max_pieces = max_pieces
        self.games = (Game(seed=seed), Game(seed=seed))
        self.turn = 0  # 次に打つ側

    def reset(self, seed: int, first: int = 0) -> None:
        self.games = (Game(seed=seed), Game(seed=seed))
        self.turn = first

    @property
    def done(self) -> bool:
        return any(g.over for g in self.games) or max(g.stats.pieces for g in self.games) >= self.max_pieces

    def position(self, side: int) -> Position:
        return Position.from_game(self.games[side])

    def candidates(self, side: int) -> list[Candidate]:
        return enumerate_candidates(self.position(side))

    def step(self, side: int, c: Candidate) -> LockResult:
        """side が 1 手打つ。出た火力はそのまま相手のおじゃまになる。"""
        g = self.games[side]
        result: LockResult | None = None
        for a in c.path:
            r = g.apply(a)
            if a == "HD":
                result = r  # type: ignore[assignment]
        assert result is not None
        other = self.games[1 - side]
        if result.sent > 0 and not other.over:
            other.receive_garbage(result.sent)
        self.turn = 1 - side
        return result
