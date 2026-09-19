"""学習・評価用の環境。Game を 1 つ持ち、ランダムなおじゃまを送ってくる相手の代わりもする。"""

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
