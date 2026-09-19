"""n-tuple ネットワーク（パターン評価）。オセロの評価関数そのもの。

考え方:
    盤面から決まった形のマスの並び（辺・角・斜めなど = パターン）を取り出し、
    その並びの石の置き方（空き/手番側/相手の 3^n 通り）ごとに点数（重み）を持つ。
    評価値 = 盤面上のすべてのパターンの点数の合計。
    同じ形は盤面の回転・反転で 8 か所に現れるので、重みを共有する。
    序盤と終盤で形の価値が違うため、石の数で「段階（stage）」を分けて別の重みを持つ。

評価値は「手番側から見た最終石差 / 64」の予想（-1〜+1 くらい）。
ブラウザ（frontend/src/games/othello/engine/evaluators.ts の NTupleEvaluator）は、ここの spec() が返す定義と
学習した重み（Float32 の並び）を受け取って同じ計算をする。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from games.othello.board import Position

PATTERN_VERSION = 1
N_STAGES = 6

# 基本パターン（(x, y) の並び）。ここを変えたら PATTERN_VERSION を上げる
BASE_PATTERNS: dict[str, list[tuple[int, int]]] = {
    "corner3x3": [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1), (0, 2), (1, 2), (2, 2)],
    "edge2x": [(x, 0) for x in range(8)] + [(1, 1), (6, 1)],
    "corner2x5": [(x, 0) for x in range(5)] + [(x, 1) for x in range(5)],
    "hv2": [(x, 1) for x in range(8)],
    "hv3": [(x, 2) for x in range(8)],
    "hv4": [(x, 3) for x in range(8)],
    "diag8": [(i, i) for i in range(8)],
    "diag7": [(i, i + 1) for i in range(7)],
    "diag6": [(i, i + 2) for i in range(6)],
    "diag5": [(i, i + 3) for i in range(5)],
    "diag4": [(i, i + 4) for i in range(4)],
}

_SYMMETRIES = (
    lambda x, y: (x, y), lambda x, y: (7 - x, y), lambda x, y: (x, 7 - y), lambda x, y: (7 - x, 7 - y),
    lambda x, y: (y, x), lambda x, y: (7 - y, x), lambda x, y: (y, 7 - x), lambda x, y: (7 - y, 7 - x),
)


def stage_of(discs: int) -> int:
    """盤上の石の数から段階を決める（4〜13 個 → 0、…、54 個以上 → 5）。"""
    return min(N_STAGES - 1, max(0, (discs - 4) // 10))


@dataclass(frozen=True)
class Instance:
    pattern: int  # BASE_PATTERNS の何番目か
    cells: tuple[int, ...]  # マス番号の並び（先頭が 3 進数の最上位桁）


def _build() -> tuple[list[str], list[int], list[int], list[Instance]]:
    names = list(BASE_PATTERNS)
    sizes = [3 ** len(BASE_PATTERNS[n]) for n in names]
    offsets = list(np.cumsum([0] + sizes[:-1]))
    instances: list[Instance] = []
    for pi, name in enumerate(names):
        seen: set[tuple[int, ...]] = set()
        for f in _SYMMETRIES:
            cells = tuple(y * 8 + x for x, y in (f(*c) for c in BASE_PATTERNS[name]))
            if cells not in seen:
                seen.add(cells)
                instances.append(Instance(pi, cells))
    return names, sizes, [int(o) for o in offsets], instances


NAMES, SIZES, OFFSETS, INSTANCES = _build()
TABLE_SIZE = sum(SIZES)  # 1 段階あたりの重みの数
_MAXLEN = max(len(i.cells) for i in INSTANCES)

# numpy で一括計算するための表（短いパターンは「常に 0 のマス（64 番）」で埋める）
_CELLS = np.full((len(INSTANCES), _MAXLEN), 64, dtype=np.int64)
_POW = np.zeros((len(INSTANCES), _MAXLEN), dtype=np.int64)
_BASE = np.array([OFFSETS[i.pattern] for i in INSTANCES], dtype=np.int64)
for k, inst in enumerate(INSTANCES):
    n = len(inst.cells)
    _CELLS[k, :n] = inst.cells
    _POW[k, :n] = 3 ** np.arange(n - 1, -1, -1)

_BIT_IDX = np.arange(64, dtype=np.uint64)


def to_cells(pos: Position) -> np.ndarray:
    """長さ 65 の配列（0 空き / 1 手番側 / 2 相手、最後の 1 つは常に 0）。"""
    p = (np.uint64(pos.P) >> _BIT_IDX) & np.uint64(1)
    o = (np.uint64(pos.O) >> _BIT_IDX) & np.uint64(1)
    out = np.zeros(65, dtype=np.int64)
    out[:64] = p.astype(np.int64) + 2 * o.astype(np.int64)
    return out


def feature_indices(cells: np.ndarray) -> np.ndarray:
    """cells: (k, 65) → 各局面・各パターンの重みの番号 (k, パターン数)。"""
    return (cells[:, _CELLS] * _POW).sum(axis=-1) + _BASE


class NTupleNet:
    def __init__(self, weights: np.ndarray | None = None):
        self.w = weights if weights is not None else np.zeros((N_STAGES, TABLE_SIZE), dtype=np.float32)

    def evaluate_many(self, positions: list[Position]) -> np.ndarray:
        """手番側から見た評価値（最終石差/64 の予想）。"""
        if not positions:
            return np.zeros(0, dtype=np.float32)
        cells = np.stack([to_cells(p) for p in positions])
        idx = feature_indices(cells)
        stages = np.array([stage_of((p.P | p.O).bit_count()) for p in positions])
        return self.w[stages[:, None], idx].sum(axis=1)

    def evaluate(self, pos: Position) -> float:
        return float(self.evaluate_many([pos])[0])

    def update(self, pos: Position, delta: float) -> None:
        """この局面で使った重みを、それぞれ delta / パターン数 ずつ動かす（勾配法の 1 歩）。

        同じ重みが 1 つの局面で何度も使われる（空の行どうしなど）と、その回数分だけ多く動くので、
        評価値そのものは delta より大きく動くことがある。
        """
        idx = feature_indices(to_cells(pos)[None, :])[0]
        stage = stage_of((pos.P | pos.O).bit_count())
        np.add.at(self.w[stage], idx, delta / len(idx))

    # --- 保存・読み込み ------------------------------------------------------
    def save(self, path: Path, meta: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.stem + ".tmp.npz")
        np.savez_compressed(tmp, w=self.w, pattern_version=PATTERN_VERSION, meta=np.array([repr(meta)]))
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path) -> "NTupleNet":
        data = np.load(path)
        if int(data["pattern_version"]) != PATTERN_VERSION:
            raise ValueError(f"{path} はパターン定義バージョン {int(data['pattern_version'])} 用です（現在 {PATTERN_VERSION}）")
        return cls(data["w"].astype(np.float32))


def spec() -> dict:
    """ブラウザに渡すパターン定義。重みは (段階, TABLE_SIZE) を行ごとに並べた Float32。"""
    return {
        "version": PATTERN_VERSION,
        "stages": N_STAGES,
        "stage_rule": "min(stages-1, max(0, floor((discs-4)/10)))",
        "table_size": TABLE_SIZE,
        "patterns": [{"name": n, "size": s, "offset": o} for n, s, o in zip(NAMES, SIZES, OFFSETS)],
        "instances": [{"pattern": i.pattern, "cells": list(i.cells)} for i in INSTANCES],
    }
