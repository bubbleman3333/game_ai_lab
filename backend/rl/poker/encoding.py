"""局面をニューラルネットに入れるベクトルにする。

**表形式（`abstraction.py`）との違い**

表形式は「強さの近い手をまとめて同じ番号にする」やり方だった。まとめた時点で情報が落ちるし、
スタックの深さごとに別々の表になるので、深いところは学習が行き渡らなかった。

ここでは**カードをそのまま入れる**（52 個の 0/1 を 2 組）。まとめないので取りこぼしが無く、
スタックの深さも 1 つの数として入れるだけなので、**深さをまたいで学習が共有される**
（10BB で覚えたことが 100BB でも効く）。そのかわり、ネットが自分で似た局面をまとめる必要があり、
学習に必要な対局数は増える。

手の強さ（`relative_strength`）と役のカテゴリも一緒に入れている。カードだけからでも学べるが、
最初から入れておくと学習が目に見えて速い。

**変えたら `FEATURE_VERSION` を上げること**（古い重みは使えなくなる）。
"""

from __future__ import annotations

import numpy as np

from games.poker.cards import (
    CATEGORY_NAMES, NUM_CARDS, hand_value, rank_of, suit_of,
)
from games.poker.cards import category_of
from games.poker.rules import BIG_BLIND, IDX_RAISE_BASE, State, to_call
from . import abstraction

FEATURE_VERSION = 1

N_CATEGORIES = len(CATEGORY_NAMES)  # 9
N_STREETS = 4
MAX_STREET_RAISES = 4.0  # 割り算で 0〜1 に収めるための目安

# ベクトルの並び（読むときの目印。長さは N_FEATURES）
_SLICES: list[tuple[str, int]] = [
    ("自分のホールカード", NUM_CARDS),
    ("ボード", NUM_CARDS),
    ("ストリート", N_STREETS),
    ("手の強さ", 1),
    ("引きかけの種類", 4),
    ("役のカテゴリ", N_CATEGORIES),
    ("プリフロップの形", 4),  # スーテッド・ペア・上のランク・下のランク
    ("チップの状況", 8),
    ("このストリートの状況", 4),
    ("ストリートごとの出し方", N_STREETS * 2),
]
N_FEATURES = sum(n for _, n in _SLICES)


def feature_names() -> list[str]:
    """どこに何が入っているかの目印（調査用）。"""
    out = []
    for name, n in _SLICES:
        out.extend(f"{name}[{i}]" for i in range(n))
    return out


def _street_stats(hist: str) -> tuple[list[float], int]:
    """ストリートごとの「行動の数」「レイズの数」と、今のストリートのレイズ数。"""
    stats = [0.0] * (N_STREETS * 2)
    segments = hist.split("/")
    raises_now = 0
    for s, seg in enumerate(segments[:N_STREETS]):
        acts = [ch for ch in seg if ch.isdigit()]
        raises = sum(1 for ch in acts if int(ch) >= IDX_RAISE_BASE)
        stats[s * 2] = min(len(acts), 4) / 4.0
        stats[s * 2 + 1] = min(raises, MAX_STREET_RAISES) / MAX_STREET_RAISES
        if s == len(segments) - 1:
            raises_now = raises
    return stats, raises_now


#: カード由来の部分の終わり。ここから先はベットの状況（局面ごとに変わる）
CARD_END = NUM_CARDS * 2 + N_STREETS + 1 + 4 + N_CATEGORIES + 4


def card_features(st: State, player: int) -> np.ndarray:
    """カードから決まる部分だけを埋めたベクトル。

    **同じプレイヤー・同じストリートなら、賭けがどう進んでも変わらない**。1 回の対局で
    何十回もネットを呼ぶので、ここを使い回せるかどうかで速さが大きく変わる。
    """
    x = np.zeros(N_FEATURES, dtype=np.float32)
    i = 0
    hole = st.holes[player]
    board = st.board

    for c in hole:
        x[i + c] = 1.0
    i += NUM_CARDS
    for c in board:
        x[i + c] = 1.0
    i += NUM_CARDS

    x[i + st.street] = 1.0
    i += N_STREETS

    # 手の強さ（プリフロップとフロップ以降で測り方が違う）。役の強さは 1 回だけ計算して使い回す
    if board:
        value = hand_value(tuple(hole) + tuple(board))
        x[i] = abstraction.relative_strength(hole, board, value)
    else:
        value = None
        x[i] = abstraction.preflop_index(hole) / 168.0  # 169 通りの番号を 0〜1 に
    i += 1

    x[i + abstraction.draw_kind(hole, board)] = 1.0
    i += 4

    if value is not None:
        x[i + category_of(value)] = 1.0
    i += N_CATEGORIES

    ra, rb = rank_of(hole[0]), rank_of(hole[1])
    hi, lo = max(ra, rb), min(ra, rb)
    x[i] = 1.0 if suit_of(hole[0]) == suit_of(hole[1]) else 0.0
    x[i + 1] = 1.0 if hi == lo else 0.0
    x[i + 2] = hi / 12.0
    x[i + 3] = lo / 12.0
    i += 4
    assert i == CARD_END, f"カード部分の長さが合わない: {i} != {CARD_END}"
    return x


def features(st: State, player: int, hist: str, cache: dict | None = None) -> np.ndarray:
    """1 局面ぶんのベクトル（float32）。**相手のホールカードは絶対に入れない**。

    `cache` を渡すと、カード由来の部分を (プレイヤー, ストリート) ごとに使い回す。
    """
    key = (player, st.street)
    base = cache.get(key) if cache is not None else None
    if base is None:
        base = card_features(st, player)
        if cache is not None:
            cache[key] = base
    x = base.copy()
    i = CARD_END

    # チップの状況。すべて開始スタックかポットで割って 0〜1 くらいに収める
    start = max(1, st.start_stack)
    need = to_call(st, player)
    opp = 1 - player
    x[i] = st.pot / (2.0 * start)
    x[i + 1] = need / max(1.0, st.pot + need)  # ポットオッズ
    x[i + 2] = st.stack_left(player) / start
    x[i + 3] = st.stack_left(opp) / start
    x[i + 4] = st.street_bet[player] / start
    x[i + 5] = st.street_bet[opp] / start
    x[i + 6] = 1.0 if st.button == player else 0.0
    x[i + 7] = min(start / BIG_BLIND, 200.0) / 200.0  # スタックの深さ（BB 何個分か）
    i += 8

    stats, raises_now = _street_stats(hist)
    x[i] = min(raises_now, MAX_STREET_RAISES) / MAX_STREET_RAISES
    x[i + 1] = 1.0 if need > 0 else 0.0
    x[i + 2] = st.committed[player] / start
    x[i + 3] = st.committed[opp] / start
    i += 4

    x[i:i + N_STREETS * 2] = stats
    i += N_STREETS * 2

    assert i == N_FEATURES, f"ベクトルの長さが合わない: {i} != {N_FEATURES}"
    return x
