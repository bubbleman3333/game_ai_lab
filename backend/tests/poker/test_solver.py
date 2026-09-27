"""その場で解くソルバー（`rl/poker/solver.py`・`search.py`）と、まとめて役を判定する `fasteval.py` のテスト。

大事なのは 3 つ。

1. numpy 版の役判定が Python 版 `hand_value` と**完全に同じ値**を返すこと。
2. レンジどうしのショーダウンの計算（ブロッカーの引き算つき）が総当たりと一致すること。
3. 解いた戦略が均衡に近づくこと（反復を増やすと搾取されやすさが下がる）と、
   それらしい打ち方になること（ナッツは賭け、ゴミはチェックが多い）。
"""

from __future__ import annotations

import numpy as np
import pytest

from games.poker.cards import Rng, hand_value, parse_cards
from games.poker.game import deal, play_hand
from games.poker.rules import (
    FLOP, PREFLOP, RIVER, TURN, action_from_index, apply_action, new_hand,
)
from rl.poker import config, deep_cfr, search, solver
from rl.poker.fasteval import hand_values
from rl.poker.model import PokerNet
from rl.poker.solver import (
    COMBO_CARDS, N_COMBOS, EquityLeaf, SolveSettings, SortedShowdown, combo_index, compat_sum,
    exploitability, runouts_for, solve, valid_mask,
)

RIVER_BOARD = parse_cards("2h7d9cJsQh")


def _river_state(button: int = 0, stack: int = 200):
    """プリフロップはリンプ・チェック、以降チェックで回してリバーの先手番。"""
    st = new_hand(((0, 5), (10, 15)), RIVER_BOARD, start_stack=stack, button=button)
    for _ in range(6):
        st = apply_action(st, action_from_index(st, 1))
    assert st.street == RIVER and not st.finished
    return st


def test_役判定はPython版と同じ値():
    rng = np.random.default_rng(0)
    for m in (5, 6, 7):
        cards = np.array([rng.choice(52, m, replace=False) for _ in range(3000)])
        got = hand_values(cards)
        want = np.array([hand_value(tuple(c)) for c in cards])
        assert np.array_equal(got, want), f"{m} 枚で食い違い"


def test_役判定の境目():
    """ホイール・フラッシュ内のストレート・ツーペアが 3 組など、間違えやすいところ。"""
    hands = ["As2d3c4h5s7d9c", "AsKsQsJsTs2d2c", "5s4s3s2sAs9d9c", "AsAdKsKdQsQd2c",
             "AsAdAcKsKdQc2c", "2s2d3s3d4s4d5c", "KsQsJsTs9s8s7s", "AsKd2c2d2h3s3d"]
    for text in hands:
        cards = parse_cards(text)
        assert int(hand_values(np.array([cards]))[0]) == hand_value(cards), text


def test_かぶらない相手の重みの合計():
    rng = np.random.default_rng(1)
    w = rng.random((1, N_COMBOS)).astype(np.float32)
    got = compat_sum(w)
    for i in (0, 77, 500, 1325):
        a, b = COMBO_CARDS[i]
        want = sum(float(w[0, j]) for j in range(N_COMBOS)
                   if a not in COMBO_CARDS[j] and b not in COMBO_CARDS[j])
        assert got[0, i] == pytest.approx(want, rel=1e-4)


def test_リバーのショーダウンは2つの計算が一致し総当たりとも合う():
    leaf = EquityLeaf(RIVER_BOARD, runouts_for(RIVER_BOARD, 10, 1))
    sorted_ = SortedShowdown(np.array([RIVER_BOARD]))
    rng = np.random.default_rng(2)
    ok = valid_mask(RIVER_BOARD)
    w = rng.random((1, N_COMBOS)).astype(np.float32) * ok
    a, b = leaf.value(w), sorted_.value(w)
    # 行列の方は低ランクに縮めているので、最大値の 1% 以内なら一致とみなす
    assert np.abs(a - b)[:, ok].max() < 0.01 * np.abs(b[:, ok]).max()
    a = b  # 総当たりとの比較は厳密な方で
    strength = [hand_value(tuple(COMBO_CARDS[i]) + RIVER_BOARD) if ok[i] else -1
                for i in range(N_COMBOS)]
    for i in np.nonzero(ok)[0][:4]:
        want = 0.0
        for j in np.nonzero(ok)[0]:
            if set(COMBO_CARDS[i]) & set(COMBO_CARDS[j]):
                continue
            want += float(w[0, j]) * np.sign(strength[i] - strength[j])
        assert a[0, i] == pytest.approx(want, abs=1e-2)


def test_ターンの葉はリバー全部の平均():
    board = parse_cards("2h7d9cJs")
    leaf = EquityLeaf(board, runouts_for(board, 100, 1), keep_dense=True)
    assert leaf.runouts == 48
    ok = np.nonzero(valid_mask(board))[0]
    rest = [c for c in range(52) if c not in board]
    for i, j in ((ok[0], ok[100]), (ok[5], ok[700])):
        total, n = 0, 0
        for c in rest:
            if c in COMBO_CARDS[i] or c in COMBO_CARDS[j]:
                continue
            total += np.sign(hand_value(tuple(COMBO_CARDS[i]) + board + (c,))
                             - hand_value(tuple(COMBO_CARDS[j]) + board + (c,)))
            n += 1
        assert n == 44
        assert leaf.dense[i, j] == pytest.approx(total / n, abs=1e-5)
    # 低ランクに縮めた方は、レンジに掛けた結果が最大値の 1% 以内で一致する
    rng = np.random.default_rng(3)
    w = rng.random((1, N_COMBOS)).astype(np.float32) * valid_mask(board)
    exact = w @ leaf.dense.T
    assert np.abs(leaf.value(w) - exact).max() < 0.01 * np.abs(exact).max()


def test_反復を増やすと搾取されにくくなる():
    st = _river_state()
    uniform = np.ones(N_COMBOS, dtype=np.float32)
    values = []
    for iters in (10, 60):
        sol = solve(st, 1, (uniform, uniform), 0, SolveSettings(iterations=iters))
        values.append(exploitability(sol, (uniform, uniform), st.board))
    assert values[1] < values[0] / 2, values
    assert values[1] < 0.1 * st.pot, "60 反復でポットの 1 割より小さくなるはず"


def test_ナッツは賭けてゴミはチェックが多い():
    st = _river_state()
    uniform = np.ones(N_COMBOS, dtype=np.float32)
    sol = solve(st, 1, (uniform, uniform), 0, SolveSettings(iterations=80))
    nuts = sol.strategy(combo_index(parse_cards("QsQd")))  # トップセット
    air = sol.strategy(combo_index(parse_cards("3c4d")))
    assert nuts.get(1, 0.0) < 0.4, f"ナッツがチェックしすぎ: {nuts}"
    assert air.get(1, 0.0) > nuts.get(1, 0.0), f"ゴミの方がナッツより賭けている: {air} / {nuts}"
    assert sum(nuts.values()) == pytest.approx(1.0)


def test_相手のレンジが弱いと強気になる():
    """相手が弱い手ばかりなら、中くらいの手でも賭ける割合が上がる。"""
    st = _river_state()
    uniform = np.ones(N_COMBOS, dtype=np.float32)
    weak = np.zeros(N_COMBOS, dtype=np.float32)
    ok = valid_mask(RIVER_BOARD)
    for i in np.nonzero(ok)[0]:
        if hand_value(tuple(COMBO_CARDS[i]) + RIVER_BOARD) < hand_value(parse_cards("2c3s") + RIVER_BOARD) + 1:
            weak[i] = 1.0
    hand = combo_index(parse_cards("Ah9s"))  # 9 のペア
    vs_uniform = solve(st, 1, (uniform, uniform), 0, SolveSettings(iterations=60)).strategy(hand)
    vs_weak = solve(st, 1, (uniform, weak), 0, SolveSettings(iterations=60)).strategy(hand)
    assert vs_weak.get(1, 0.0) < vs_uniform.get(1, 0.0)


def test_木は合法手だけで作られ枠の数と合う():
    st = _river_state()
    root = solver.build_tree(st, 0, SolveSettings())
    assert root.player == 1
    assert root.actions == [1, 2, 3, 4], "リバーの先手番はチェック・0.5 ポット・1 ポット・オールイン"
    assert root.regret.shape == (4, 1, N_COMBOS)


def test_履歴の復元():
    st = deal(Rng(3), start_stack=200, button=0)
    steps, final = search.replay(st, "31/1")
    assert [(p, idx) for _, p, idx, _ in steps] == [(0, 3), (1, 1), (1, 1)]
    assert final.street == FLOP and final.to_act == 0
    assert steps[2][3] == "31/", "そこまでの履歴はストリートの区切りを含む"


def test_ネットで相手のレンジを更新できる():
    net = PokerNet(deep_cfr.N_ACTIONS, hidden=16, layers=1).to_numpy()
    st = deal(Rng(4), start_stack=200, button=0)
    steps, _ = search.replay(st, "3")
    s, p, idx, prefix = steps[0]
    probs = search.model_probs(net, s, p, prefix, epsilon=0.05)
    assert probs.shape == (N_COMBOS, deep_cfr.N_ACTIONS)
    ok = valid_mask(s.board)
    assert np.allclose(probs[ok].sum(axis=1), 1.0, atol=1e-4)
    assert (probs[ok] > 0).all(), "epsilon を混ぜているので 0 にならない"


def test_その場で解くプレイヤーは打てない手を選ばずレンジを持ち越す():
    net = PokerNet(deep_cfr.N_ACTIONS, hidden=16, layers=1).to_numpy()
    me = search.search_player(net, seed=1, settings=search.fast_settings())
    opp = search.search_player(net, seed=2, settings=search.fast_settings())
    r = Rng(5)
    for i in range(3):
        st = deal(r, start_stack=60, button=i % 2)
        result = play_hand(st, (me, opp), config.RAISE_FRACTIONS, config.MAX_RAISES_PER_STREET)
        assert sum(result.payoff) == 0
        assert me.last_probs is not None and abs(sum(me.last_probs) - 1.0) < 1e-6
    assert me.memo is not None
    # 保存して読み直しても同じレンジ
    dumped = me.dump_memo()
    again = search.search_player(net, seed=1)
    again.load_memo(dumped)
    assert again.memo["n"] == me.memo["n"]
    assert np.allclose(again.memo["ranges"][0], me.memo["ranges"][0], atol=1e-5)


def test_プリフロップの解は使い回される():
    net = PokerNet(deep_cfr.N_ACTIONS, hidden=16, layers=1).to_numpy()
    settings = search.fast_settings()[PREFLOP]
    search._preflop_cache.clear()
    a = search.preflop_solution(net, 60, 0, "", 0.05, settings)
    b = search.preflop_solution(net, 60, 0, "", 0.05, settings)
    assert a is b
    c = search.preflop_solution(net, 60, 0, "3", 0.05, settings)
    assert c.root.player == 1, "SB がレイズしたあとは BB の手番"
    assert len(search._preflop_cache) == 2


def test_ターンとフロップも解ける():
    st = new_hand(((0, 5), (10, 15)), RIVER_BOARD, start_stack=200, button=0)
    for _ in range(4):
        st = apply_action(st, action_from_index(st, 1))
    assert st.street == TURN
    uniform = np.ones(N_COMBOS, dtype=np.float32)
    sol = solve(st, 1, (uniform, uniform), 0, SolveSettings(iterations=15))
    assert sum(sol.strategy(combo_index(parse_cards("QsQd"))).values()) == pytest.approx(1.0)
    st = new_hand(((0, 5), (10, 15)), RIVER_BOARD, start_stack=200, button=0)
    for _ in range(2):
        st = apply_action(st, action_from_index(st, 1))
    assert st.street == FLOP
    sol = solve(st, 1, (uniform, uniform), 0, SolveSettings(iterations=15, flop_runouts=20))
    assert sum(sol.strategy(combo_index(parse_cards("9s9d"))).values()) == pytest.approx(1.0)
