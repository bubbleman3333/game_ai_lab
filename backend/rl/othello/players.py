"""手を選ぶプレイヤー（評価用の対戦相手と、学習した評価関数で打つプレイヤー）。

どれも choose(pos) -> マス番号 を持つ。pos は手番側が打てる局面（Position.normalize() 済み）。
"""

from __future__ import annotations

import random
from typing import Protocol

from games.othello.board import Position, bits, popcount

from .ntuple import NTupleNet


class Player(Protocol):
    name: str

    def choose(self, pos: Position) -> int: ...


class RandomPlayer:
    name = "random"

    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)

    def choose(self, pos: Position) -> int:
        return self.rng.choice(list(bits(pos.moves())))


# 昔ながらの「マスの重み表」（角が高く、角の隣が低い）
_SQUARE_WEIGHTS = [
    100, -20, 10, 5, 5, 10, -20, 100,
    -20, -50, -2, -2, -2, -2, -50, -20,
    10, -2, -1, -1, -1, -1, -2, 10,
    5, -2, -1, -1, -1, -1, -2, 5,
    5, -2, -1, -1, -1, -1, -2, 5,
    10, -2, -1, -1, -1, -1, -2, 10,
    -20, -50, -2, -2, -2, -2, -50, -20,
    100, -20, 10, 5, 5, 10, -20, 100,
]
# 重みごとにマスをまとめたビットマスク（評価を速くするため）
_WEIGHT_MASKS: list[tuple[int, int]] = []
for _w in sorted(set(_SQUARE_WEIGHTS)):
    _WEIGHT_MASKS.append((_w, sum(1 << i for i, v in enumerate(_SQUARE_WEIGHTS) if v == _w)))


def positional_eval(pos: Position) -> float:
    """手番側から見たマスの重みの合計 + 打てる手の数の差。"""
    s = sum(w * (popcount(pos.P & m) - popcount(pos.O & m)) for w, m in _WEIGHT_MASKS)
    return s + 5 * (popcount(pos.moves()) - popcount(pos.passed().moves()))


class PositionalPlayer:
    """マスの重み表で depth 手先まで読む（アルファベータ法）。GA などで作りがちな AI の代表。"""

    def __init__(self, depth: int = 1, seed: int = 0):
        self.depth = depth
        self.name = f"positional-d{depth}"
        self.rng = random.Random(seed)

    def choose(self, pos: Position) -> int:
        best, best_moves = -1e18, []
        for sq in bits(pos.moves()):
            v = -self._negamax(pos.play(sq), self.depth - 1, -1e18, 1e18)
            if v > best + 1e-9:
                best, best_moves = v, [sq]
            elif abs(v - best) <= 1e-9:
                best_moves.append(sq)
        return self.rng.choice(best_moves)

    def _negamax(self, pos: Position, depth: int, alpha: float, beta: float) -> float:
        moves = pos.moves()
        if not moves:
            if not pos.passed().moves():
                return 10000 * pos.final_score()
            return -self._negamax(pos.passed(), depth, -beta, -alpha)
        if depth <= 0:
            return positional_eval(pos)
        for sq in bits(moves):
            v = -self._negamax(pos.play(sq), depth - 1, -beta, -alpha)
            if v > alpha:
                alpha = v
                if alpha >= beta:
                    break
        return alpha


def child_values(net: NTupleNet, pos: Position) -> tuple[list[int], list[float]]:
    """pos の各合法手について「打った後の局面の価値（pos の手番側から見て）」を返す。"""
    moves = list(bits(pos.moves()))
    values: list[float | None] = [None] * len(moves)
    to_eval: list[Position] = []
    signs: list[tuple[int, float]] = []
    for i, sq in enumerate(moves):
        c = pos.play(sq)
        if c.is_over():
            values[i] = -c.final_score() / 64  # c は相手番なので符号を反転
        elif not c.moves():
            to_eval.append(c.passed())  # 相手がパス → また自分の番
            signs.append((i, 1.0))
        else:
            to_eval.append(c)
            signs.append((i, -1.0))
    if to_eval:
        v = net.evaluate_many(to_eval)
        for (i, sign), x in zip(signs, v):
            values[i] = sign * float(x)
    return moves, values  # type: ignore[return-value]


class NTuplePlayer:
    """学習した評価関数で 1 手先を読んで打つ（epsilon の確率でランダム）。"""

    def __init__(self, net: NTupleNet, epsilon: float = 0.0, seed: int = 0, name: str = "ntuple"):
        self.net = net
        self.epsilon = epsilon
        self.rng = random.Random(seed)
        self.name = name

    def choose(self, pos: Position) -> int:
        moves, values = child_values(self.net, pos)
        if self.epsilon and self.rng.random() < self.epsilon:
            return self.rng.choice(moves)
        return moves[max(range(len(moves)), key=values.__getitem__)]
