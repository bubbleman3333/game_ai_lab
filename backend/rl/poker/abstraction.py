"""手札とボードを「バケツ」にまとめる（カードの抽象化）。

ノーリミット・ホールデムの局面は 10^160 通りあり、そのままでは表に載らない。
**打ち方がほとんど同じになる手は同じ扱いにしてよい**ので、強さの近い手をまとめる。

- プリフロップ: 169 通り（AA, AKs, AKo, …）。ここはまとめない（数が少ないので損がない）。
- フロップ以降: 「**このボードで相手が持ちうる手のうち、何 % に勝っているか**」で段階に分け、
  さらに「フラッシュを引きかけ」「ストレートを引きかけ」を別扱いにする。

強さを**ボードを踏まえて**測るのが大事。単に「役の絶対的な強さ」で測ると、
A K Q のボードで 2 3 を持っている（ほぼ最弱）のに「A ハイだから中くらい」と出てしまう。
相手が持ちうる手と比べれば、ちゃんと下の方に入る。

相手の手を全部（1225 通り）調べると遅すぎるので、**ボードから決まる乱数**で選んだ
`PROBE_COUNT` 通りの見本と比べる。乱数の種はボードだけから決まるので、
同じ局面はいつでも必ず同じバケツになる（学習した戦略が後からずれない）。

引きかけ（ドロー）を分けるのは大事で、まとめてしまうと**今は弱いが伸びる手**を
降りるようになり、打ち方が固くなりすぎる。

まとめ方を変えたら `config.ABSTRACTION_VERSION` を上げること（古い戦略は使えなくなる）。
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from games.poker.cards import hand_value, rank_of, suit_of
from . import config

# 4 枚そろっていてあと 1 枚でストレートになるランクの組み合わせ（13 ビットの集合で引く）
_STRAIGHT_DRAW = [False] * 8192
_WHEEL = (1 << 12) | 0b1111


def _build_straight_draw_table() -> None:
    windows = [0b11111 << h for h in range(9)]  # 下端 2〜10 のストレート
    windows.append(_WHEEL)  # A,2,3,4,5
    for mask in range(8192):
        for w in windows:
            if bin(mask & w).count("1") == 4:
                _STRAIGHT_DRAW[mask] = True
                break


_build_straight_draw_table()


def _board_seed(board: tuple[int, ...]) -> int:
    """ボードから決まる乱数の種（並び順によらないように小さい順に足す）。"""
    seed = config.PROBE_SEED
    for c in sorted(board):
        seed = (seed * 53 + c + 1) & 0x7FFFFFFF
    return seed


@lru_cache(maxsize=8192)
def _probe_values(board: tuple[int, ...]) -> np.ndarray:
    """このボードで「相手が持ちうる手」の見本の強さを、小さい順に並べたもの。

    ボードから種が決まるので、同じボードならいつでも同じ見本になる。
    1 回の対局では同じボードを何度も引くので、覚えておけば十分速い。
    """
    rng = np.random.default_rng(_board_seed(board))
    rest = [c for c in range(52) if c not in board]
    # 1 回の並べ替えから 2 枚ずつ取り出す（乱数を 1 回で済ませる。ここが一番効く）
    order = rng.permutation(len(rest))
    need = config.PROBE_COUNT * 2
    while len(order) < need:
        order = np.concatenate([order, rng.permutation(len(rest))])
    values = np.empty(config.PROBE_COUNT, dtype=np.int64)
    for i in range(config.PROBE_COUNT):
        a, b = rest[order[i * 2]], rest[order[i * 2 + 1]]
        values[i] = hand_value((a, b) + board)
    values.sort()
    return values


def relative_strength(hole: tuple[int, int], board: tuple[int, ...], value: int | None = None) -> float:
    """このボードで、相手が持ちうる手のうちどれだけに勝っているか（0〜1）。

    `value` に `hand_value(hole + board)` を渡せば、その計算を省ける（呼び出し側で
    役のカテゴリにも使うときに効く）。
    """
    probes = _probe_values(tuple(board))
    v = hand_value(tuple(hole) + tuple(board)) if value is None else value
    return float(np.searchsorted(probes, v, side="left")) / len(probes)


def preflop_index(hole: tuple[int, int]) -> int:
    """プリフロップの 169 通りの番号。

    0〜12 = ポケットペア（22〜AA）、13〜90 = スーテッド、91〜168 = オフスーツ。
    """
    a, b = hole
    ra, rb = rank_of(a), rank_of(b)
    hi, lo = max(ra, rb), min(ra, rb)
    if hi == lo:
        return lo
    suited = suit_of(a) == suit_of(b)
    pair_index = hi * (hi - 1) // 2 + lo  # hi > lo の 78 通りを 0〜77 に詰める
    return 13 + pair_index + (0 if suited else 78)


def draw_kind(hole: tuple[int, int], board: tuple[int, ...]) -> int:
    """引きかけ（ドロー）の種類。0 = なし、1 = ストレート、2 = フラッシュ、3 = 両方。

    リバー（ボード 5 枚）ではもう引けないので必ず 0。
    """
    if len(board) >= 5:
        return 0
    cards = tuple(hole) + tuple(board)
    suit_counts = [0, 0, 0, 0]
    mask = 0
    for c in cards:
        suit_counts[suit_of(c)] += 1
        mask |= 1 << rank_of(c)
    flush = 1 if max(suit_counts) == 4 else 0
    straight = 1 if _STRAIGHT_DRAW[mask] else 0
    return straight + flush * 2


def bucket(hole: tuple[int, int], board: tuple[int, ...]) -> int:
    """局面のバケツ番号。プリフロップとフロップ以降で番号の意味が違う（ストリートも鍵に入れる）。"""
    if not board:
        return preflop_index(hole)
    pct = relative_strength(hole, board)
    step = min(config.STRENGTH_BUCKETS - 1, int(pct * config.STRENGTH_BUCKETS))
    return step * config.DRAW_KINDS + draw_kind(hole, board)


def bucket_count(street: int) -> int:
    return config.PREFLOP_BUCKETS if street == 0 else config.POSTFLOP_BUCKETS


def describe_bucket(street: int, index: int) -> str:
    """調査のための説明。"""
    chars = "23456789TJQKA"
    if street == 0:
        if index < 13:
            return "ポケットペア " + chars[index] * 2
        rest = index - 13
        suited = rest < 78
        pair_index = rest % 78
        hi = 1
        while hi * (hi + 1) // 2 <= pair_index:
            hi += 1
        lo = pair_index - hi * (hi - 1) // 2
        return chars[hi] + chars[lo] + ("s" if suited else "o")
    step, draw = divmod(index, config.DRAW_KINDS)
    lo = 100 * step // config.STRENGTH_BUCKETS
    hi = 100 * (step + 1) // config.STRENGTH_BUCKETS
    names = ("ドローなし", "ストレートドロー", "フラッシュドロー", "両面ドロー")
    return f"勝てる相手 {lo}〜{hi}% / {names[draw]}"
