"""ポーカーのカードと役の判定（純粋な Python。Django に依存しない）。

カードは 0〜51 の整数 1 つで表す。

    card = rank * 4 + suit
    rank: 0=2, 1=3, … 8=T, 9=J, 10=Q, 11=K, 12=A
    suit: 0=s(スペード), 1=h(ハート), 2=d(ダイヤ), 3=c(クラブ)

文字列は "As" "Td" "2c" の形（ランク 1 文字 + スート 1 文字）。

役の強さ `hand_value()` は**整数 1 つ**で返す（大きいほど強い）。上位にカテゴリ
（ハイカード 0 〜 ストレートフラッシュ 8）を置き、その下に「意味のあるランク」を
4 ビットずつ 5 つ並べてあるので、**整数の大小比較だけで役の比較ができる**。
引き分けは値が完全に一致する（スートは強さに関係しないため）。

TypeScript 版は frontend/src/games/poker/engine/cards.ts。変えたら両方直し、
`python -m games.poker.fixtures` でテストデータを作り直すこと。
"""

from __future__ import annotations

from typing import Iterable, Sequence

RANK_CHARS = "23456789TJQKA"
SUIT_CHARS = "shdc"
NUM_CARDS = 52
DECK = tuple(range(NUM_CARDS))

# 役のカテゴリ（大きいほど強い）
CAT_HIGH_CARD = 0
CAT_PAIR = 1
CAT_TWO_PAIR = 2
CAT_TRIPS = 3
CAT_STRAIGHT = 4
CAT_FLUSH = 5
CAT_FULL_HOUSE = 6
CAT_QUADS = 7
CAT_STRAIGHT_FLUSH = 8

CATEGORY_NAMES = (
    "ハイカード", "ワンペア", "ツーペア", "スリーカード", "ストレート",
    "フラッシュ", "フルハウス", "フォーカード", "ストレートフラッシュ",
)

_CAT_SHIFT = 20  # ランク 5 つ（4 ビット × 5）の上にカテゴリを置く


def make_card(rank: int, suit: int) -> int:
    return rank * 4 + suit


def rank_of(card: int) -> int:
    return card >> 2


def suit_of(card: int) -> int:
    return card & 3


def card_str(card: int) -> str:
    return RANK_CHARS[card >> 2] + SUIT_CHARS[card & 3]


def cards_str(cards: Iterable[int]) -> str:
    return " ".join(card_str(c) for c in cards)


def parse_card(text: str) -> int:
    t = text.strip()
    if len(t) != 2:
        raise ValueError(f"カードの書き方が違う: {text!r}")
    r = RANK_CHARS.find(t[0].upper())
    s = SUIT_CHARS.find(t[1].lower())
    if r < 0 or s < 0:
        raise ValueError(f"カードの書き方が違う: {text!r}")
    return make_card(r, s)


def parse_cards(text: str) -> tuple[int, ...]:
    """"As Kd" でも "AsKd" でも読める。"""
    t = text.replace(",", " ").split()
    if len(t) == 1 and len(t[0]) > 2:
        chunk = t[0]
        t = [chunk[i:i + 2] for i in range(0, len(chunk), 2)]
    return tuple(parse_card(x) for x in t)


# ---- 役の判定に使う先計算テーブル（13 ビットのランク集合を引く） ----

_POPCOUNT = [0] * 8192
_STRAIGHT_HIGH = [0] * 8192  # 0 = ストレートなし。それ以外は「一番上のランク + 1」
_TOP5 = [0] * 8192  # 上から 5 つのランクを詰めた値
_WHEEL = (1 << 12) | 0b1111  # A,2,3,4,5


def _pack(ranks: Sequence[int]) -> int:
    """意味のある順に並べたランクを 4 ビット × 5 に詰める（0 = なし、なので +1 して入れる）。"""
    v = 0
    for i, r in enumerate(ranks[:5]):
        v |= (r + 1) << (4 * (4 - i))
    return v


for _mask in range(8192):
    _POPCOUNT[_mask] = bin(_mask).count("1")
    _top: list[int] = []
    for _r in range(12, -1, -1):
        if _mask >> _r & 1:
            _top.append(_r)
            if len(_top) == 5:
                break
    _TOP5[_mask] = _pack(_top)
    _hi = 0
    for _h in range(12, 3, -1):
        _need = 0b11111 << (_h - 4)
        if _mask & _need == _need:
            _hi = _h + 1
            break
    else:
        if _mask & _WHEEL == _WHEEL:
            _hi = 3 + 1  # 5 ハイ（A を 1 として使う）
    _STRAIGHT_HIGH[_mask] = _hi


def _straight_ranks(high: int) -> list[int]:
    """ストレートの 5 枚のランクを上から並べる（5 ハイだけ A が一番下になる）。"""
    if high == 3:  # 5,4,3,2,A
        return [3, 2, 1, 0, 12]
    return [high - i for i in range(5)]


def hand_value(cards: Sequence[int]) -> int:
    """5 枚以上のカードから一番強い 5 枚の役の強さを返す（大きいほど強い）。"""
    suit_masks = [0, 0, 0, 0]
    rank_count = [0] * 13
    mask = 0
    for c in cards:
        r = c >> 2
        suit_masks[c & 3] |= 1 << r
        rank_count[r] += 1
        mask |= 1 << r

    flush_mask = 0
    for sm in suit_masks:
        if _POPCOUNT[sm] >= 5:
            flush_mask = sm
            break

    if flush_mask:
        sh = _STRAIGHT_HIGH[flush_mask]
        if sh:
            return (CAT_STRAIGHT_FLUSH << _CAT_SHIFT) | _pack(_straight_ranks(sh - 1))

    quads: list[int] = []
    trips: list[int] = []
    pairs: list[int] = []
    for r in range(12, -1, -1):
        n = rank_count[r]
        if n == 4:
            quads.append(r)
        elif n == 3:
            trips.append(r)
        elif n == 2:
            pairs.append(r)

    if quads:
        q = quads[0]
        kicker = max(r for r in range(13) if r != q and rank_count[r])
        return (CAT_QUADS << _CAT_SHIFT) | _pack([q, kicker])

    if trips:
        rest = trips[1:] + pairs
        if rest:
            return (CAT_FULL_HOUSE << _CAT_SHIFT) | _pack([trips[0], max(rest)])

    if flush_mask:
        return (CAT_FLUSH << _CAT_SHIFT) | _TOP5[flush_mask]

    sh = _STRAIGHT_HIGH[mask]
    if sh:
        return (CAT_STRAIGHT << _CAT_SHIFT) | _pack(_straight_ranks(sh - 1))

    if trips:
        t = trips[0]
        kickers = [r for r in range(12, -1, -1) if r != t and rank_count[r]][:2]
        return (CAT_TRIPS << _CAT_SHIFT) | _pack([t] + kickers)

    if len(pairs) >= 2:
        hi, lo = pairs[0], pairs[1]
        kicker = max(r for r in range(13) if r not in (hi, lo) and rank_count[r])
        return (CAT_TWO_PAIR << _CAT_SHIFT) | _pack([hi, lo, kicker])

    if pairs:
        p = pairs[0]
        kickers = [r for r in range(12, -1, -1) if r != p and rank_count[r]][:3]
        return (CAT_PAIR << _CAT_SHIFT) | _pack([p] + kickers)

    return (CAT_HIGH_CARD << _CAT_SHIFT) | _TOP5[mask]


def category_of(value: int) -> int:
    return value >> _CAT_SHIFT


def value_name(value: int) -> str:
    """役の名前（画面と説明用）。"""
    cat = category_of(value)
    ranks = [(value >> (4 * (4 - i))) & 0xF for i in range(5)]
    chars = [RANK_CHARS[r - 1] for r in ranks if r]
    name = CATEGORY_NAMES[cat]
    if cat in (CAT_STRAIGHT, CAT_STRAIGHT_FLUSH):
        return f"{name}（{chars[0]} ハイ）"
    if cat in (CAT_FLUSH, CAT_HIGH_CARD):
        return f"{name}（{chars[0]} ハイ）"
    if cat in (CAT_PAIR, CAT_TRIPS, CAT_QUADS):
        return f"{name}（{chars[0]}）"
    if cat == CAT_TWO_PAIR:
        return f"{name}（{chars[0]} と {chars[1]}）"
    return f"{name}（{chars[0]} と {chars[1]}）"  # フルハウス


def compare(a: Sequence[int], b: Sequence[int]) -> int:
    """a のほうが強ければ 1、弱ければ -1、引き分けなら 0。"""
    va, vb = hand_value(a), hand_value(b)
    return (va > vb) - (va < vb)


class Rng:
    """mulberry32。TypeScript 版の Rng と同じ値を同じ順番で返す（games/blob と同じもの）。"""

    __slots__ = ("s",)

    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.s = (self.s + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = ((t + ((t ^ (t >> 7)) * (t | 61))) & 0xFFFFFFFF) ^ t
        return (t ^ (t >> 14)) / 4294967296

    def int(self, n: int) -> int:
        return int(self.next() * n)


def shuffled_deck(rng: Rng) -> list[int]:
    """Fisher-Yates で 52 枚を混ぜる（TypeScript 版と同じ順番になる）。"""
    deck = list(DECK)
    for i in range(len(deck) - 1, 0, -1):
        j = rng.int(i + 1)
        deck[i], deck[j] = deck[j], deck[i]
    return deck
