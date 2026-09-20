"""抽象化（バケツ分け）・相手役・学習した戦略の入れ物のテスト。"""

from __future__ import annotations

import random

import pytest

from games.poker.cards import Rng, parse_cards
from rl.poker import abstraction, config, evaluate, exploit, mccfr, players

def test_プリフロップは169通りに分かれる():
    seen = set()
    for a in range(52):
        for b in range(a + 1, 52):
            seen.add(abstraction.preflop_index((a, b)))
    assert len(seen) == config.PREFLOP_BUCKETS == 169


def test_プリフロップの番号は2枚の順番によらない():
    for _ in range(200):
        a, b = random.sample(range(52), 2)
        assert abstraction.preflop_index((a, b)) == abstraction.preflop_index((b, a))


def test_バケツは同じ局面ならいつも同じ():
    """ボードから決まる乱数を使うので、何度呼んでもぶれない（ぶれると学習が無駄になる）。"""
    hole, board = parse_cards("9s8s"), parse_cards("Ts7d2c")
    first = abstraction.bucket(hole, board)
    abstraction._probe_values.cache_clear()
    assert abstraction.bucket(hole, board) == first
    assert abstraction.bucket((hole[1], hole[0]), board) == first


def test_ボードを踏まえた強さになっている():
    """絶対的な役の強さではなく「このボードで何 % に勝っているか」で測れていること。

    A K Q のボードで 2 3 は最弱に近い。役だけ見ると「A ハイ」で中くらいに見えてしまう。
    """
    board = parse_cards("AhKdQs")
    worst = abstraction.relative_strength(parse_cards("2c3d"), board)
    pair = abstraction.relative_strength(parse_cards("2s2h"), board)
    trips = abstraction.relative_strength(parse_cards("AsAc"), board)
    assert worst < 0.15, f"最弱の手が弱く出ていない: {worst}"
    assert worst < pair < trips
    assert trips > 0.9


def test_引きかけは別のバケツに入る():
    """今は弱いが伸びる手を、ただの弱い手と同じ扱いにしない。"""
    board = parse_cards("Ts7d2c")
    draw = abstraction.bucket(parse_cards("9s8s"), board)  # ストレートを引きかけ
    plain = abstraction.bucket(parse_cards("9s4d"), board)
    assert abstraction.draw_kind(parse_cards("9s8s"), board) != 0
    assert draw != plain


def test_リバーには引きかけがない():
    board = parse_cards("Ts7d2c3h4s")
    assert abstraction.draw_kind(parse_cards("9s8s"), board) == 0


def test_Chen_formula():
    assert players.chen_score(parse_cards("AsAh")) == 20
    assert players.chen_score(parse_cards("7s2h")) == -1
    assert players.chen_score(parse_cards("AsKs")) == 12
    assert players.preflop_strength(parse_cards("AsAh")) == 1.0


def test_ルールベースはでたらめより強い():
    """基準の相手として使えることの確認（勝てないなら比較相手にならない）。"""
    result = evaluate.head_to_head(players.heuristic(1), players.random_player(2), hands=1200, seed=3)
    assert result.mbb_per_hand > 200, f"ルールベースが弱すぎる: {result}"


def test_いつも降りる相手はブラインドで飛ぶ():
    result = evaluate.survival(players.heuristic(1), players.folder(), matches=6,
                               start_stack=100, max_hands=300, seed=2)
    assert result.busted == 0
    assert result.bust_rate == 0.0


def test_ミラー方式は同じ相手どうしなら差がつかない():
    """同じカードで席を入れ替えるので、まったく同じ打ち方どうしなら収支は 0 になる。"""
    result = evaluate.head_to_head(players.caller(), players.caller(), hands=600, seed=5)
    assert result.chips == 0


def test_学習した戦略は保存して読み直せる(tmp_path):
    table = mccfr.Table()
    deck, rng = Rng(3), random.Random(3)
    for t in range(1, 61):
        mccfr.run_iteration(table, deck, rng, t, 0)
    assert len(table) > 100

    path = tmp_path / "s.npz"
    mccfr.save(path, table, {"episode": 60})
    again = mccfr.load(path)
    assert len(again) == len(table)
    key = next(iter(table.regret))
    assert again.regret[key] == pytest.approx(table.regret[key], abs=1e-3)

    strategy = mccfr.Strategy.from_file(path)
    assert len(strategy) == len(table)
    assert strategy.meta["episode"] == 60


def test_学習した戦略は打てない手を選ばない(tmp_path):
    table = mccfr.Table()
    deck, rng = Rng(4), random.Random(4)
    for t in range(1, 41):
        mccfr.run_iteration(table, deck, rng, t, 2)
    strategy = mccfr.Strategy.from_table(table)
    policy = players.strategy_player(strategy, seed=1)
    # 打てない手を選ぶと play_hand が例外を投げる
    from games.poker.game import deal, play_hand

    r = Rng(9)
    for i in range(40):
        st = deal(r, start_stack=200, button=i % 2)
        result = play_hand(st, (policy, policy), config.RAISE_FRACTIONS,
                           config.MAX_RAISES_PER_STREET)
        assert sum(result.payoff) == 0


def test_情報集合の鍵に相手の手札が入っていない():
    """不完全情報ゲームで一番大事なところ。入っていたらカンニングになる。"""
    table = mccfr.Table()
    deck, rng = Rng(5), random.Random(5)
    for t in range(1, 21):
        mccfr.run_iteration(table, deck, rng, t, 1)
    for key in table.regret:
        head, hist = key.split("|", 1)
        assert head[0].isdigit(), "先頭はスタックの深さの番号"
        assert head[1] in "pftr", "次はストリート"
        assert all(ch.isdigit() or ch == "/" for ch in hist), "履歴は行動の番号と区切りだけ"


def test_レイズ額の枠はゲーム側と学習側で必ず一致する():
    """2 か所に持つと「学習していない手を打たせる」事故になるので、同じものを使う。"""
    from games.poker import rules

    assert config.RAISE_FRACTIONS is rules.RAISE_FRACTIONS
    assert mccfr.N_ACTIONS == rules.ACTION_COUNT


def test_スタックの深さは近いものに割り当てられる():
    """設定を変えても崩れないように「一番近い深さが選ばれる」ことだけを見る。"""
    depths = config.STACK_DEPTHS_BB
    for stack in (20, 40, 70, 100, 150, 200, 1000):
        picked = config.depth_bucket(stack)
        best = min(range(len(depths)), key=lambda i: abs(depths[i] - stack / 2))
        assert picked == best
    assert config.depth_bucket(10_000) == len(depths) - 1, "学習した中で一番深いものに寄せる"


def test_搾取する相手役は弱い相手から大きく取れる():
    """「この AI はどれだけ食い物にできるか」を測る道具が、ちゃんと食い物にできること。

    いつも降りる相手なら、こちらは毎回攻めるだけで確実に取れる。ここで取れないなら
    道具が壊れている（＝AI が強そうに見えても信用できない）。
    """
    out = exploit.measure(players.folder(), iterations=400, hands=600,
                          stack=100 * 2, seed=3)
    assert out["exploited_mbb_per_hand"] > 300, f"弱い相手から取れていない: {out}"
    assert out["infosets"] > 0


def test_AIの指定はファイルでも名前でもよい():
    policy = exploit._load_policy("heuristic")
    from games.poker.game import deal, play_hand
    from games.poker.cards import Rng

    st = deal(Rng(1), start_stack=200, button=0)
    result = play_hand(st, (policy, policy), config.RAISE_FRACTIONS,
                       config.MAX_RAISES_PER_STREET)
    assert sum(result.payoff) == 0
