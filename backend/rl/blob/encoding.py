"""候補手の結果（置いた後の盤面）をニューラルネットの入力ベクトルにする。

特徴量を増減したら FEATURE_VERSION を上げること。古いチェックポイントは読み込み時にエラーになる。

一番大事なのは「あと 1 個置けば何連鎖するか」（chain_potential）。連鎖は組んでいる途中の
盤面が「よい形かどうか」を得点だけでは測れないので、この見積りを特徴量として渡している。
"""

from __future__ import annotations

import numpy as np

from games.blob import COLORS, Field, GARBAGE, H, VISIBLE_H, W
from games.blob.rules import simulate_chain

from .position import Candidate

FEATURE_VERSION = 2

FEATURE_NAMES: list[str] = (
    [f"height_{x}" for x in range(W)]
    + [
        "max_height", "sum_height", "bumpiness", "spawn_room",
        "links", "groups3", "groups2", "buried_garbage", "garbage",
        "potential_chain", "potential_score", "potential_garbage_free",
        "chain", "popped", "score", "attack", "sent", "all_clear",
        "pending", "carry", "dead",
    ]
    + [f"color_{c}" for c in range(1, COLORS + 1)]
    + [f"next_axis_{c}" for c in range(1, COLORS + 1)]
    + [f"next_child_{c}" for c in range(1, COLORS + 1)]
    + ["next_same", "next_known"]
)
FEATURE_DIM = len(FEATURE_NAMES)

# だいたい 0〜1 に収まるようにするための割り算の値。
# 得点は連鎖数に対してねずみ算式に増える（5 連鎖 4840 点 → 9 連鎖 27880 点）ので、
# 3000 で割ると大連鎖で飽和してしまう。大連鎖を学ばせる以上、ここは広めに取る。
_SCALE = np.array(
    [H] * W
    + [H, W * H, 30, H, 40, 8, 16, 20, 40, 12, 20000, 12, 12, 30, 20000, 200, 200, 1, 30, 70, 1]
    + [20] * COLORS + [1] * COLORS + [1] * COLORS + [1, 1],
    dtype=np.float32,
)


def chain_potential(field: Field) -> tuple[int, int]:
    """あと 1 個どこかに置いたとき、最大で何連鎖するか（連鎖数, 得点）。

    落とした粒が消えるには同じ色の隣とつながる必要があるので、着地点の隣にある色だけを試す。
    """
    heights = field.heights()
    best = (0, 0)
    for x in range(W):
        y = heights[x]
        if y >= VISIBLE_H:
            continue
        colors = {c for c in (field.get(x - 1, y), field.get(x + 1, y), field.get(x, y - 1)) if 1 <= c <= COLORS}
        for c in colors:
            f = field.clone()
            f.set(x, y, c)
            chain, _, score = simulate_chain(f)
            if (chain, score) > best:
                best = (chain, score)
    return best


def shape_features(field: Field) -> dict[str, float]:
    """盤面の形（高さ・つながり・おじゃま）。"""
    cells = field.cells
    heights = field.heights()
    links = 0  # 同じ色が隣り合っている数
    sizes: dict[int, int] = {}  # まとまりの大きさ -> 個数
    seen = bytearray(W * H)
    color_count = [0] * (COLORS + 1)
    garbage = 0
    buried = 0
    for y in range(H):
        for x in range(W):
            v = cells[y * W + x]
            if v == GARBAGE:
                garbage += 1
                if y + 1 < H and cells[(y + 1) * W + x]:
                    buried += 1
                continue
            if v == 0:
                continue
            color_count[v] += 1
            if y >= VISIBLE_H:
                continue  # 13 段目の粒は消えないので、つながりに数えない
            if x + 1 < W and cells[y * W + x + 1] == v:
                links += 1
            if y + 1 < VISIBLE_H and cells[(y + 1) * W + x] == v:
                links += 1
    # つながりの大きさ（2 個・3 個は「あと少しで消える形」なので数える）
    for i in range(W * VISIBLE_H):
        v = cells[i]
        if v < 1 or v > COLORS or seen[i]:
            continue
        stack = [i]
        seen[i] = 1
        n = 0
        while stack:
            j = stack.pop()
            n += 1
            jx, jy = j % W, j // W
            for nx, ny in ((jx + 1, jy), (jx - 1, jy), (jx, jy + 1), (jx, jy - 1)):
                if 0 <= nx < W and 0 <= ny < VISIBLE_H:
                    k = ny * W + nx
                    if not seen[k] and cells[k] == v:
                        seen[k] = 1
                        stack.append(k)
        sizes[n] = sizes.get(n, 0) + 1
    return {
        "heights": heights,
        "max_height": max(heights),
        "sum_height": sum(heights),
        "bumpiness": sum(abs(heights[i] - heights[i + 1]) for i in range(W - 1)),
        "links": links,
        "groups3": sizes.get(3, 0),
        "groups2": sizes.get(2, 0),
        "garbage": garbage,
        "buried": buried,
        "colors": color_count[1:],
    }


def encode(c: Candidate) -> np.ndarray:
    f = shape_features(c.field_after)
    chain, score = chain_potential(c.field_after)
    r = c.result
    nxt = c.next_after
    v: list[float] = list(f["heights"]) + [
        f["max_height"], f["sum_height"], f["bumpiness"], H - f["heights"][2],
        f["links"], f["groups3"], f["groups2"], f["buried"], f["garbage"],
        chain, score, chain if f["garbage"] == 0 else 0,
        r.chain, r.popped, r.score, r.attack, r.sent, float(r.all_clear),
        c.pending_after, c.carry_after, float(c.dead),
    ]
    v += list(f["colors"])
    v += [float(nxt is not None and nxt[0] == col) for col in range(1, COLORS + 1)]
    v += [float(nxt is not None and nxt[1] == col) for col in range(1, COLORS + 1)]
    v += [float(nxt is not None and nxt[0] == nxt[1]), float(nxt is not None)]
    return np.asarray(v, dtype=np.float32) / _SCALE


def encode_many(cands: list[Candidate]) -> np.ndarray:
    if not cands:
        return np.zeros((0, FEATURE_DIM), dtype=np.float32)
    return np.stack([encode(c) for c in cands])
