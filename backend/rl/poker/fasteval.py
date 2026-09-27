"""役の判定を numpy でまとめて行う（`games.poker.cards.hand_value` と同じ値を返す）。

その場で解くソルバー（`solver.py`）は、1 つのボードについて **1326 通りのホールカード全部**の
強さを何十枚ものランアウト（この先めくれるカード）ごとに求める。1 局面で数十万回になるので、
1 つずつ Python で判定していては間に合わない。ここでは (N, 7) の配列をまとめて判定する。

値の並び（カテゴリ << 20 | 意味のあるランク 4 ビット × 5）は `hand_value` と完全に同じにしてある。
`tests/poker/test_solver.py` で乱数の手 5 万通りを `hand_value` と突き合わせて縛っている。
"""

from __future__ import annotations

import numpy as np

from games.poker.cards import (
    CAT_FLUSH, CAT_FULL_HOUSE, CAT_HIGH_CARD, CAT_PAIR, CAT_QUADS, CAT_STRAIGHT,
    CAT_STRAIGHT_FLUSH, CAT_TRIPS, CAT_TWO_PAIR, _CAT_SHIFT,
)

_RANKS = np.arange(13)
_SHIFTS = np.array([16, 12, 8, 4, 0], dtype=np.int64)  # 上から 5 つのランクの置き場所


def _pack(ranks: np.ndarray) -> np.ndarray:
    """(N, 5) のランク（無いところは -1）→ 4 ビット × 5 に詰めた値。`cards._pack` と同じ。"""
    return ((ranks + 1).clip(min=0).astype(np.int64) << _SHIFTS).sum(axis=1)


def _top_ranks(mask: np.ndarray, k: int = 5) -> np.ndarray:
    """(N, 13) の「あるランク」→ 上から k 個のランク（無いところは -1）。"""
    vals = np.where(mask, _RANKS, -1)
    return -np.sort(-vals, axis=1)[:, :k]


def _straight_high(mask: np.ndarray) -> np.ndarray:
    """(N, 13) のランク集合 → ストレートの一番上のランク（無ければ -1、A2345 は 3）。"""
    n = mask.shape[0]
    high = np.full(n, -1, dtype=np.int64)
    wheel = mask[:, 12] & mask[:, 0] & mask[:, 1] & mask[:, 2] & mask[:, 3]
    high[wheel] = 3
    for h in range(4, 13):  # 上のランクほど後で書いて勝たせる
        ok = mask[:, h - 4:h + 1].all(axis=1)
        high[ok] = h
    return high


def _straight_ranks(high: np.ndarray) -> np.ndarray:
    """ストレートの 5 枚を上から並べる（5 ハイだけ A が一番下）。"""
    ranks = high[:, None] - np.arange(5)[None, :]
    wheel = high == 3
    ranks[wheel] = np.array([3, 2, 1, 0, 12])
    return ranks


def hand_values(cards: np.ndarray) -> np.ndarray:
    """(N, 5〜7) のカード → (N,) の役の強さ（`hand_value` と同じ整数）。"""
    cards = np.asarray(cards, dtype=np.int64)
    n = cards.shape[0]
    ranks = cards >> 2
    suits = cards & 3
    onehot = ranks[:, :, None] == _RANKS  # (N, M, 13)
    rank_count = onehot.sum(axis=1)  # (N, 13)
    rank_mask = rank_count > 0

    # スートごとのランク集合 (N, 4, 13)
    suit_rank = np.zeros((n, 4, 13), dtype=bool)
    for s in range(4):
        suit_rank[:, s] = (onehot & (suits == s)[:, :, None]).any(axis=1)
    suit_count = suit_rank.sum(axis=2)
    flush_suit = suit_count.argmax(axis=1)
    has_flush = suit_count.max(axis=1) >= 5
    flush_mask = suit_rank[np.arange(n), flush_suit] & has_flush[:, None]

    sf_high = np.where(has_flush, _straight_high(flush_mask), -1)
    is_sf = sf_high >= 0
    v_sf = (CAT_STRAIGHT_FLUSH << _CAT_SHIFT) | _pack(_straight_ranks(np.maximum(sf_high, 0)))

    quad_rank = _top_ranks(rank_count == 4, 1)[:, 0]
    is_quads = quad_rank >= 0
    kicker_q = _top_ranks(rank_mask & (_RANKS != quad_rank[:, None]), 1)[:, 0]
    v_quads = (CAT_QUADS << _CAT_SHIFT) | _pack(np.stack(
        [quad_rank, kicker_q, -np.ones(n, dtype=np.int64), -np.ones(n, dtype=np.int64),
         -np.ones(n, dtype=np.int64)], axis=1))

    trips = _top_ranks(rank_count == 3, 2)  # (N, 2)
    pairs = _top_ranks(rank_count == 2, 3)  # (N, 3)
    has_trips = trips[:, 0] >= 0
    fh_second = np.maximum(trips[:, 1], pairs[:, 0])
    is_fh = has_trips & (fh_second >= 0)
    neg = -np.ones((n, 3), dtype=np.int64)
    v_fh = (CAT_FULL_HOUSE << _CAT_SHIFT) | _pack(np.concatenate(
        [trips[:, :1], fh_second[:, None], neg], axis=1))

    v_flush = (CAT_FLUSH << _CAT_SHIFT) | _pack(_top_ranks(flush_mask, 5))

    st_high = _straight_high(rank_mask)
    is_straight = st_high >= 0
    v_straight = (CAT_STRAIGHT << _CAT_SHIFT) | _pack(_straight_ranks(np.maximum(st_high, 0)))

    t = trips[:, 0]
    kick_t = _top_ranks(rank_mask & (_RANKS != t[:, None]), 2)
    v_trips = (CAT_TRIPS << _CAT_SHIFT) | _pack(np.concatenate(
        [t[:, None], kick_t, neg[:, :2]], axis=1))

    hi, lo = pairs[:, 0], pairs[:, 1]
    is_two_pair = lo >= 0
    kick_2 = _top_ranks(rank_mask & (_RANKS != hi[:, None]) & (_RANKS != lo[:, None]), 1)
    v_two = (CAT_TWO_PAIR << _CAT_SHIFT) | _pack(np.concatenate(
        [hi[:, None], lo[:, None], kick_2, neg[:, :2]], axis=1))

    is_pair = hi >= 0
    kick_1 = _top_ranks(rank_mask & (_RANKS != hi[:, None]), 3)
    v_pair = (CAT_PAIR << _CAT_SHIFT) | _pack(np.concatenate(
        [hi[:, None], kick_1, neg[:, :1]], axis=1))

    v_high = (CAT_HIGH_CARD << _CAT_SHIFT) | _pack(_top_ranks(rank_mask, 5))

    return np.select(
        [is_sf, is_quads, is_fh, has_flush, is_straight, has_trips, is_two_pair, is_pair],
        [v_sf, v_quads, v_fh, v_flush, v_straight, v_trips, v_two, v_pair],
        default=v_high,
    )
