"""ベットの進行（ノーリミット・ヘッズアップ）のテスト。"""

from __future__ import annotations

import random

import pytest

from games.poker.cards import Rng, parse_cards
from games.poker.game import deal, play_hand, play_match
from games.poker.rules import (
    BIG_BLIND, FLOP, IDX_ALL_IN, IDX_CHECK_CALL, IDX_FOLD, IDX_RAISE_BASE, PREFLOP, RAISE,
    RIVER, SMALL_BLIND, Action, action_from_index, apply_action, legal_actions, legal_mask,
    max_raise_to, min_raise_to, new_hand, payoff, to_call, translate,
)

HOLES = ((0, 5), (10, 15))
BOARD = parse_cards("2h7d9cJsQh")


def _hand(stack: int = 200, button: int = 0):
    return new_hand(HOLES, BOARD, start_stack=stack, button=button)


def _step(st, index):
    return apply_action(st, action_from_index(st, index))


def test_ブラインドを出した状態から始まる():
    st = _hand()
    assert st.committed == (SMALL_BLIND, BIG_BLIND)
    assert st.to_act == 0, "ヘッズアップのプリフロップはボタン（SB）から"
    assert to_call(st) == SMALL_BLIND


def test_プリフロップでコールしてもビッグブラインドは行動できる():
    st = _step(_hand(), IDX_CHECK_CALL)  # SB がコール
    assert st.street == PREFLOP
    assert st.to_act == 1
    mask = legal_mask(st)
    assert mask[IDX_CHECK_CALL] and mask[IDX_ALL_IN]
    assert not mask[IDX_FOLD], "コールが要らない場面ではフォールドできない"
    st = _step(st, IDX_CHECK_CALL)  # BB がチェック
    assert st.street == FLOP
    assert st.to_act == 1, "フロップ以降はボタンでない側から"


def test_フォールドしたら相手が出した分だけ勝つ():
    st = _step(_hand(), IDX_ALL_IN)  # SB がオールイン
    st = _step(st, IDX_FOLD)  # BB が降りる
    assert st.finished and st.folded == 1
    assert payoff(st) == (BIG_BLIND, -BIG_BLIND), "降りた側が出した分しか動かない"


def test_最低レイズ幅は直前のレイズ幅以上():
    st = _hand()
    assert min_raise_to(st) == 4  # BB 2 + 最低 2
    st = _step(st, IDX_RAISE_BASE)  # SB が最小に近いレイズ
    lo = min_raise_to(st)
    assert lo == st.street_bet[0] + (st.street_bet[0] - st.street_bet[1])
    with pytest.raises(ValueError):
        apply_action(st, Action(RAISE, to=lo - 1))


def test_オールインを超える額は打てない():
    st = _hand(stack=50)
    hi = max_raise_to(st)
    assert hi == 50
    with pytest.raises(ValueError):
        apply_action(st, Action(RAISE, to=hi + 1))


def test_相手がオールインならレイズできずコールかフォールド():
    st = _step(_hand(), IDX_ALL_IN)
    mask = legal_mask(st)
    assert mask[IDX_FOLD] and mask[IDX_CHECK_CALL]
    assert not any(mask[IDX_RAISE_BASE:]), "返せない相手にレイズさせない"


def test_オールインが揃ったらリバーまで進んでショーダウン():
    st = _step(_hand(), IDX_ALL_IN)
    st = _step(st, IDX_CHECK_CALL)
    assert st.finished and st.street == RIVER
    assert len(st.board) == 5
    assert sum(payoff(st)) == 0


def test_スタックが違うと多い方の余りは戻る():
    """短い方のスタックまでしか勝負にならない。"""
    st = new_hand(HOLES, BOARD, start_stack=30, button=0)
    st = _step(st, IDX_ALL_IN)  # 30 まで
    st = _step(st, IDX_CHECK_CALL)
    p0, p1 = payoff(st)
    assert p0 + p1 == 0
    assert abs(p0) == 30


def test_人間の任意額を一番近い枠に読み替える():
    st = _hand()
    assert translate(st, RAISE, to=1000) == IDX_ALL_IN
    assert translate(st, RAISE, to=4) == IDX_RAISE_BASE
    sizes = {a.index: a.to for a in legal_actions(st) if a.kind == RAISE}
    near = translate(st, RAISE, to=7)
    assert min(sizes, key=lambda i: abs(sizes[i] - 7)) == near


def test_ランダムな手を打ち続けても必ず終わり収支は0になる():
    rnd = random.Random(7)

    def policy(state, player):
        mask = legal_mask(state)
        return rnd.choice([i for i, ok in enumerate(mask) if ok])

    rng = Rng(99)
    for i in range(400):
        st = deal(rng, start_stack=200, button=i % 2)
        result = play_hand(st, (policy, policy))
        assert result.final.finished
        assert sum(result.payoff) == 0
        for p in (0, 1):
            assert 0 <= result.final.committed[p] <= 200


def test_連戦はどちらかが飛ぶまで続く():
    rnd = random.Random(3)

    def wild(state, player):
        """いつでもオールインする乱暴な打ち方（必ず決着が付く）。"""
        mask = legal_mask(state)
        return IDX_ALL_IN if mask[IDX_ALL_IN] else IDX_CHECK_CALL

    def timid(state, player):
        mask = legal_mask(state)
        return IDX_FOLD if mask[IDX_FOLD] else IDX_CHECK_CALL

    result = play_match((wild, timid), seed=5, start_stack=200, max_hands=500)
    assert result.busted == 1, "降りてばかりだとブラインドで飛ぶ"
    assert sum(result.chips) == 0
    assert result.hands < 500
