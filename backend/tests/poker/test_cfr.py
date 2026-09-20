"""CFR+ と搾取されやすさ（exploitability）の計算が正しいかのテスト。

不完全情報ゲームの学習は「動いているように見えて実は均衡に近づいていない」ことが多い。
そこで**答えが分かっているクーンポーカー**を基準にする。
"""

from __future__ import annotations

import numpy as np

from rl.poker import cfr, toy

KUHN_VALUE = -1.0 / 18.0  # クーンポーカーの先手の期待値（理論値）


def _kuhn_nash(alpha: float) -> dict[str, np.ndarray]:
    """クーンポーカーの厳密な均衡（alpha は 0〜1/3 の好きな値。どれも均衡）。

    カードは 0=J, 1=Q, 2=K。情報集合の名前は「自分のカード|公開カード|行動の履歴」。
    行動は履歴が空のとき (チェック, ベット)、ベットされた後は (フォールド, コール)。
    """
    a = alpha
    return {
        "0||": np.array([1 - a, a]),
        "1||": np.array([1.0, 0.0]),
        "2||": np.array([1 - 3 * a, 3 * a]),
        "0||cr": np.array([1.0, 0.0]),
        "1||cr": np.array([1 - (a + 1 / 3), a + 1 / 3]),
        "2||cr": np.array([0.0, 1.0]),
        "0||r": np.array([1.0, 0.0]),
        "1||r": np.array([2 / 3, 1 / 3]),
        "2||r": np.array([0.0, 1.0]),
        "0||c": np.array([2 / 3, 1 / 3]),
        "1||c": np.array([1.0, 0.0]),
        "2||c": np.array([0.0, 1.0]),
    }


def test_クーンポーカーの情報集合は12個():
    g = toy.make("kuhn")
    table = cfr.train(g, 5)
    assert table.infosets == 12


def test_Leducの情報集合は288個():
    """Leduc ホールデムの情報集合の数は研究でよく使われる 288 個。"""
    g = toy.make("leduc")
    table = cfr.train(g, 2)
    assert table.infosets == 288


def test_理論上の均衡は搾取されない():
    """厳密な均衡を入れたら exploitability がほぼ 0 になること（＝測り方が正しいこと）。"""
    g = toy.make("kuhn")
    for alpha in (0.0, 1 / 6, 1 / 3):
        s = _kuhn_nash(alpha)
        assert abs(cfr.exploitability(g, s)) < 1e-9
        assert abs(cfr.game_value(g, s) - KUHN_VALUE) < 1e-9


def test_クーンポーカーで均衡に近づく():
    g = toy.make("kuhn")
    s = cfr.train(g, 300).average()
    assert abs(cfr.game_value(g, s) - KUHN_VALUE) < 1e-3, "期待値が理論値 -1/18 に寄らない"
    assert cfr.exploitability(g, s) < 1e-3, "搾取されやすさが下がりきらない"


def test_反復を増やすほど搾取されにくくなる():
    g = toy.make("kuhn")
    values = [cfr.exploitability(g, cfr.train(g, n).average()) for n in (20, 100, 500)]
    assert values[0] > values[1] > values[2], f"単調に下がっていない: {values}"


def test_Leducでも均衡に近づく():
    g = toy.make("leduc")
    coarse = cfr.exploitability(g, cfr.train(g, 20).average())
    fine = cfr.exploitability(g, cfr.train(g, 80).average())
    assert fine < coarse
    assert fine < 0.05, f"搾取されやすさが大きすぎる: {fine}"


def test_均衡どうしなら期待値はゼロサム():
    """ゲームの値は「先手 +v、後手 -v」。合計は必ず 0。"""
    g = toy.make("leduc")
    s = cfr.train(g, 30).average()
    v = cfr.game_value(g, s)
    br0 = cfr.best_response_value(g, s, 0)
    br1 = cfr.best_response_value(g, s, 1)
    assert br0 >= v - 1e-9, "先手が最善で応じたのに期待値が下がっている"
    assert br1 >= -v - 1e-9, "後手が最善で応じたのに期待値が下がっている"


def test_小さなポーカーのルールが壊れていない():
    g = toy.make("leduc")
    s = g.root()
    assert g.is_chance(s)
    # カードを 3 枚（自分・相手・公開）配ると賭けが始まる
    outcomes = g.chance_outcomes(s)
    assert abs(sum(p for _, p in outcomes) - 1.0) < 1e-12
    s = outcomes[0][0]
    s = g.chance_outcomes(s)[0][0]
    assert not g.is_chance(s), "ホールカードを配り終えたら賭けが始まる"
    assert g.player(s) == 0
    assert g.actions(s) == ("c", "r"), "賭けが無い場面ではフォールドできない"
    # 降りたら相手が出した分（アンティ 1）だけ動く
    after_bet = g.apply(s, "r")
    folded = g.apply(after_bet, "f")
    assert g.is_terminal(folded)
    assert g.terminal_value(folded) == 1.0
