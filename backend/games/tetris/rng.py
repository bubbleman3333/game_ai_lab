"""TypeScript 版と同じ値を出す乱数 (mulberry32) と 7-bag。"""

from __future__ import annotations

from .pieces import PIECE_TYPES

_MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _MASK


class Mulberry32:
    def __init__(self, seed: int):
        self.state = seed & _MASK

    def next_float(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & _MASK
        t = self.state
        t = _imul(t ^ (t >> 15), t | 1)
        t = ((t + _imul(t ^ (t >> 7), t | 61)) & _MASK) ^ t
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    def next_int(self, n: int) -> int:
        """0 以上 n 未満の整数。"""
        return int(self.next_float() * n)


class BagRandomizer:
    def __init__(self, seed: int):
        self._rng = Mulberry32(seed)

    def next_bag(self) -> list[str]:
        bag = list(PIECE_TYPES)
        for i in range(len(bag) - 1, 0, -1):
            j = self._rng.next_int(i + 1)
            bag[i], bag[j] = bag[j], bag[i]
        return bag
