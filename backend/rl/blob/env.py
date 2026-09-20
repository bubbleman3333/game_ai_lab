"""学習・評価用の環境。BlobGame を 1 つ持ち、ランダムなおじゃまを送ってくる相手の代わりもする。"""

from __future__ import annotations

import random

from games.blob import BlobGame, ChainResult

from .position import Candidate, Position, enumerate_candidates


class BlobEnv:
    def __init__(self, max_pairs: int = 400, garbage_rate: float = 0.0, seed: int = 0):
        self.max_pairs = max_pairs
        self.garbage_rate = garbage_rate  # 1 手あたりに送られてくるおじゃまの期待個数
        self._rng = random.Random(seed)
        self.game = BlobGame(seed=seed)
        self.fired: list[int] = []  # 撃った連鎖の段数（1 回の発火につき 1 つ）

    def reset(self, seed: int) -> None:
        self.game = BlobGame(seed=seed)
        self._rng.seed(seed)
        self.fired = []

    @property
    def done(self) -> bool:
        return self.game.over or self.game.stats.pairs >= self.max_pairs

    @property
    def truncated(self) -> bool:
        """上限の手数に達して打ち切られた（死んではいない）。"""
        return not self.game.over and self.game.stats.pairs >= self.max_pairs

    def position(self) -> Position:
        return Position.from_game(self.game)

    def candidates(self) -> list[Candidate]:
        return enumerate_candidates(self.position())

    def step(self, c: Candidate) -> ChainResult:
        """候補どおりに置き、予告のおじゃまを降らせて次の組を出す。"""
        result = self.game.place(c.x, c.rot)
        # 先読みと実際の結果がずれていたらエンジンのバグ
        assert result.chain == c.result.chain and result.sent == c.result.sent, (c.x, c.rot, result)
        if result.chain:
            self.fired.append(result.chain)
        self._maybe_send_garbage()
        self.game.drop_garbage()
        self.game.spawn()
        return result

    def _maybe_send_garbage(self) -> None:
        if self.garbage_rate <= 0 or self.game.over:
            return
        # 1〜12 個（平均 6.5 個）をまとめて送る。1 手あたりの期待値が garbage_rate になるようにする
        if self._rng.random() < self.garbage_rate / 6.5:
            self.game.receive_garbage(self._rng.randint(1, 12))

    def chain_stats(self, big: int = 6) -> dict:
        """連鎖の組み方の成績。big 段以上を「大連鎖」として数える。"""
        fired = self.fired
        return {
            "fires": len(fired),
            "avg_fire_chain": sum(fired) / len(fired) if fired else 0.0,
            "big_chains": sum(1 for n in fired if n >= big),
            "small_fires": sum(1 for n in fired if n <= 2),
        }
