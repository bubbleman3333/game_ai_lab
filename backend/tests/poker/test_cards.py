"""役の判定のテスト。速い判定（games.poker.cards）を、素朴な総当たり判定と突き合わせる。"""

from __future__ import annotations

import random
from itertools import combinations

from games.poker.cards import (
    CAT_FLUSH, CAT_FULL_HOUSE, CAT_HIGH_CARD, CAT_PAIR, CAT_QUADS, CAT_STRAIGHT,
    CAT_STRAIGHT_FLUSH, CAT_TRIPS, CAT_TWO_PAIR, category_of, hand_value, parse_cards,
)


def _naive5(cards: tuple[int, ...]) -> tuple:
    """5 枚の役を、速さを考えずに素直に求める（比較用のタプルを返す）。"""
    ranks = sorted((c >> 2 for c in cards), reverse=True)
    suits = [c & 3 for c in cards]
    flush = len(set(suits)) == 1
    uniq = sorted(set(ranks), reverse=True)
    straight_high = None
    if len(uniq) == 5:
        if uniq[0] - uniq[4] == 4:
            straight_high = uniq[0]
        elif uniq == [12, 3, 2, 1, 0]:  # A,5,4,3,2
            straight_high = 3
    counts: dict[int, int] = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    # (枚数, ランク) の大きい順に並べる
    groups = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    shape = [n for _, n in groups]
    ordered = [r for r, _ in groups]

    if flush and straight_high is not None:
        return (CAT_STRAIGHT_FLUSH, straight_high)
    if shape[0] == 4:
        return (CAT_QUADS, ordered[0], ordered[1])
    if shape[:2] == [3, 2]:
        return (CAT_FULL_HOUSE, ordered[0], ordered[1])
    if flush:
        return (CAT_FLUSH, *ranks)
    if straight_high is not None:
        return (CAT_STRAIGHT, straight_high)
    if shape[0] == 3:
        return (CAT_TRIPS, *ordered)
    if shape[:2] == [2, 2]:
        return (CAT_TWO_PAIR, *ordered)
    if shape[0] == 2:
        return (CAT_PAIR, *ordered)
    return (CAT_HIGH_CARD, *ranks)


def _naive7(cards: tuple[int, ...]) -> tuple:
    return max(_naive5(c) for c in combinations(cards, 5))


def test_各カテゴリの強さの順番():
    order = [
        "2s7h9dTcJh",   # ハイカード
        "2s2h9dTcJh",   # ワンペア
        "2s2h9d9cJh",   # ツーペア
        "2s2h2d9cJh",   # スリーカード
        "5s4h3d2cAh",   # ストレート（5 ハイ）
        "2s7s9sTsJs",   # フラッシュ
        "2s2h2d9c9h",   # フルハウス
        "2s2h2d2cJh",   # フォーカード
        "5s4s3s2sAs",   # ストレートフラッシュ（5 ハイ）
    ]
    values = [hand_value(parse_cards(h)) for h in order]
    assert values == sorted(values), "カテゴリの強さの順番が違う"
    assert [category_of(v) for v in values] == list(range(9))


def test_ホイールは一番弱いストレート():
    wheel = hand_value(parse_cards("5s4h3d2cAh"))
    six = hand_value(parse_cards("6s5h4d3c2h"))
    ace_high = hand_value(parse_cards("AsKhQdJcTh"))
    assert wheel < six < ace_high


def test_キッカーで勝ち負けが決まる():
    assert hand_value(parse_cards("AsAhKdQc9h")) > hand_value(parse_cards("AsAhKdJc9h"))
    assert hand_value(parse_cards("AsAhKdQc9h")) == hand_value(parse_cards("AdAcKsQh9s"))


def test_7枚から一番強い5枚を選ぶ():
    # ストレートフラッシュとフォーカードが同時にある形
    assert category_of(hand_value(parse_cards("5s4s3s2sAs9h9d"))) == CAT_STRAIGHT_FLUSH
    # ボードのフラッシュより手札を足した上のフラッシュ
    v = hand_value(parse_cards("AsKs2s7s9s3h4d"))
    assert category_of(v) == CAT_FLUSH


def test_総当たり判定と一致する():
    """ランダムな 7 枚 3000 通りで、速い判定と素朴な判定の「強さの順番」が一致することを見る。"""
    rnd = random.Random(1234)
    hands = []
    for _ in range(3000):
        hands.append(tuple(rnd.sample(range(52), 7)))
    fast = [hand_value(h) for h in hands]
    slow = [_naive7(h) for h in hands]
    for i in range(0, len(hands), 7):
        for j in range(i + 1, min(i + 7, len(hands))):
            f = (fast[i] > fast[j]) - (fast[i] < fast[j])
            s = (slow[i] > slow[j]) - (slow[i] < slow[j])
            assert f == s, f"判定が食い違う: {hands[i]} vs {hands[j]}"
