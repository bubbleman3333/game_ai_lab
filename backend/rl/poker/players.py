"""相手役（評価の基準）と、学習した戦略で打つプレイヤー。

学習した AI が本当に強いのかは、基準になる相手と比べないと分からない。オセロの「重み表 +
アルファベータ」と同じ役回りで、ここに素朴な相手を並べておく。

- `random_player` 打てる手から適当に選ぶ
- `caller` いつもチェック/コール（コーリングステーション）
- `folder` 降りられるなら降りる（ブラインドを払い続けて必ず飛ぶ）
- `maniac` いつもオールイン
- `heuristic` 手札の強さで決めるルールベース。**これが本命の比較相手**

`heuristic` のプリフロップの強さは Chen formula（人がよく使うプリフロップの点数付け）を使う。
計算が要らず、それなりに理にかなっている。フロップ以降は `abstraction.relative_strength`
（このボードで相手が持ちうる手のうち何 % に勝っているか）を使う。
"""

from __future__ import annotations

import math
import random

from games.poker.cards import rank_of, suit_of
from games.poker.game import PolicyFn
from games.poker.rules import (
    IDX_CHECK_CALL, IDX_FOLD, IDX_RAISE_BASE, State, legal_mask, to_call,
)
from . import abstraction, config
from .mccfr import N_ACTIONS, Strategy, street_raises

_FRACTIONS = config.RAISE_FRACTIONS
_MAX_RAISES = config.MAX_RAISES_PER_STREET
IDX_ALL_IN = N_ACTIONS - 1  # 枠の数は倍率の設定で変わるので、ここで数え直す

# Chen formula の高い方のカードの点数（2〜A）
_CHEN_POINTS = (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0, 7.0, 8.0, 10.0)
_CHEN_GAP_PENALTY = (0, 1, 2, 4, 5)


def chen_score(hole: tuple[int, int]) -> float:
    """プリフロップの点数（Chen formula）。72o の -1 から AA の 20 まで。"""
    ra, rb = rank_of(hole[0]), rank_of(hole[1])
    hi, lo = max(ra, rb), min(ra, rb)
    score = _CHEN_POINTS[hi]
    if hi == lo:
        score = max(5.0, score * 2)
    if suit_of(hole[0]) == suit_of(hole[1]):
        score += 2
    if hi != lo:
        gap = hi - lo - 1
        score -= _CHEN_GAP_PENALTY[min(gap, 4)]
        if gap <= 1 and hi < 10:  # 両方 Q 未満で隣り合っていればストレートになりやすい
            score += 1
    return math.ceil(score)


def preflop_strength(hole: tuple[int, int]) -> float:
    """Chen formula を 0〜1 に直したもの。"""
    return (chen_score(hole) + 1) / 21.0


def hand_strength(st: State, player: int) -> float:
    """今の手の強さ（0〜1）。プリフロップとフロップ以降で測り方が違う。"""
    if not st.board:
        return preflop_strength(st.holes[player])
    return abstraction.relative_strength(st.holes[player], st.board)


def random_player(seed: int = 0):
    rng = random.Random(seed)

    def act(st: State, player: int, hist: str) -> int:
        mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, street_raises(hist))
        return rng.choice([i for i, ok in enumerate(mask) if ok])

    return act


def caller():
    def act(st: State, player: int, hist: str) -> int:
        return IDX_CHECK_CALL

    return act


def folder():
    def act(st: State, player: int, hist: str) -> int:
        return IDX_FOLD if to_call(st, player) > 0 else IDX_CHECK_CALL

    return act


def maniac():
    def act(st: State, player: int, hist: str) -> int:
        mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, street_raises(hist))
        return IDX_ALL_IN if mask[IDX_ALL_IN] else IDX_CHECK_CALL

    return act


def heuristic(seed: int = 0, tightness: float = 0.55, aggression: float = 0.25):
    """手札の強さで決めるルールベース。

    - 強さが `tightness` + 余裕を超えたらレイズ
    - 「コールに必要な額 / コールした後のポット」（ポットオッズ）より強さが上ならコール
    - それ以下なら、賭けが無ければチェック、あればフォールド
    - `aggression` の確率でブラフのレイズを混ぜる（混ぜないと読まれて食い物にされる）
    """
    rng = random.Random(seed)

    def act(st: State, player: int, hist: str) -> int:
        mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, street_raises(hist))
        strength = hand_strength(st, player)
        call = to_call(st, player)
        raise_indexes = [i for i in range(IDX_RAISE_BASE, N_ACTIONS) if mask[i]]

        if raise_indexes:
            if strength >= 0.92 and mask[IDX_ALL_IN] and st.street >= 2:
                return IDX_ALL_IN  # 終盤に非常に強ければ全部出す
            if strength >= tightness + 0.2:
                return raise_indexes[min(1, len(raise_indexes) - 1)]
            if strength >= tightness:
                return raise_indexes[0]
            if rng.random() < aggression * (1.0 - strength):
                return raise_indexes[0]  # ブラフ

        if call == 0:
            return IDX_CHECK_CALL
        pot_odds = call / (st.pot + call)
        if strength >= pot_odds + 0.05:
            return IDX_CHECK_CALL
        return IDX_FOLD if mask[IDX_FOLD] else IDX_CHECK_CALL

    return act


def strategy_player(strategy: Strategy, seed: int = 0, purify: float = 0.0,
                    fallback: PolicyFn | None = None):
    """学習した戦略で打つ。

    `fallback` は**まだ学習していない場面**で使う打ち方（既定はルールベース）。
    学習の途中では知らない場面がいくらでも出るので、ここを等確率にすると
    「ときどき急にでたらめを打つ」一番弱い打ち方になってしまう。

    `purify` を上げると、確率の小さい手を切り捨ててから選び直す。まとめた（抽象化した）
    戦略では、こうして「迷いを減らす」方が実戦で強くなることが知られている。
    """
    rng = random.Random(seed)
    if fallback is None:
        fallback = heuristic(seed + 1)

    def act(st: State, player: int, hist: str) -> int:
        depth = config.depth_bucket(st.start_stack)
        got = strategy.lookup(st, hist, depth)
        if got is None:
            return fallback(st, player, hist)
        probs = list(got)
        if purify > 0.0:
            kept = [p if p >= purify else 0.0 for p in probs]
            if sum(kept) > 0:
                probs = kept
        total = sum(probs)
        roll = rng.random() * total
        acc = 0.0
        for i, p in enumerate(probs):
            acc += p
            if roll < acc:
                return i
        return max(range(len(probs)), key=lambda i: probs[i])

    return act


#: 名前で呼べる相手役（評価と API で使う）
BASELINES = {
    "random": lambda seed=0: random_player(seed),
    "caller": lambda seed=0: caller(),
    "folder": lambda seed=0: folder(),
    "maniac": lambda seed=0: maniac(),
    "heuristic": lambda seed=0: heuristic(seed),
    "heuristic-loose": lambda seed=0: heuristic(seed, tightness=0.42, aggression=0.45),
}

BASELINE_LABELS = {
    "random": "でたらめ",
    "caller": "いつもコール",
    "folder": "いつも降りる",
    "maniac": "いつもオールイン",
    "heuristic": "ルールベース（かたい）",
    "heuristic-loose": "ルールベース（ゆるい）",
}
