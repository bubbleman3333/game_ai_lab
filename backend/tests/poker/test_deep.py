"""ニューラルネット版（Deep CFR）のテスト。

一番大事なのは、表形式のときと同じで「**相手の手札が入り込んでいないこと**」。
ネットは入力に入ったものは何でも使うので、うっかり入れるとカンニングする AI ができてしまう。
"""

from __future__ import annotations

import random

import numpy as np
import pytest

from games.poker.cards import Rng, parse_cards
from games.poker.game import deal, play_hand
from games.poker.rules import legal_mask, new_hand
from rl.poker import config, deep_cfr, encoding, model, players
from rl.poker.deep_cfr import DeepConfig

BOARD = parse_cards("2h7d9cJsQh")


def _state(stack: int = 200):
    return new_hand(((0, 5), (10, 15)), BOARD, start_stack=stack, button=0)


def test_特徴量の長さが定義と合っている():
    st = _state()
    x = encoding.features(st, 0, "")
    assert x.shape == (encoding.N_FEATURES,)
    assert x.dtype == np.float32
    assert len(encoding.feature_names()) == encoding.N_FEATURES


def test_相手のホールカードは特徴量に入らない():
    """相手の手札だけ差し替えても、自分から見た特徴量は 1 ビットも変わってはいけない。"""
    a = new_hand(((0, 5), (10, 15)), BOARD, start_stack=200)
    b = new_hand(((0, 5), (20, 25)), BOARD, start_stack=200)
    assert np.array_equal(encoding.features(a, 0, "1"), encoding.features(b, 0, "1"))
    # 自分の手札を変えたら、当然変わる
    c = new_hand(((1, 6), (10, 15)), BOARD, start_stack=200)
    assert not np.array_equal(encoding.features(a, 0, "1"), encoding.features(c, 0, "1"))


def test_特徴量の使い回しは結果を変えない():
    """カード由来の部分を覚えておく仕組みが、値を変えていないこと。"""
    st = _state()
    cache: dict = {}
    for hist in ("", "1", "2", "1/1"):
        assert np.array_equal(encoding.features(st, 0, hist),
                              encoding.features(st, 0, hist, cache))


def test_スタックの深さが特徴量に入っている():
    """1 つのネットで全部の深さを扱うので、深さが入っていないと区別できない。"""
    shallow = encoding.features(_state(stack=40), 0, "")
    deep = encoding.features(_state(stack=400), 0, "")
    assert not np.array_equal(shallow, deep)


def test_numpy版のネットはPyTorch版と同じ答えを出す():
    import torch

    net = model.PokerNet(deep_cfr.N_ACTIONS, hidden=32, layers=2)
    for p in net.parameters():
        torch.nn.init.normal_(p, std=0.3)
    npnet = net.to_numpy()
    rng = np.random.default_rng(0)
    for _ in range(20):
        x = rng.random(encoding.N_FEATURES).astype(np.float32)
        with torch.no_grad():
            want = net(torch.from_numpy(x)).numpy()
        assert np.allclose(npnet(x), want, atol=1e-4)


def test_後悔マッチング():
    mask = [True, True, False, True, True]
    # 正の後悔があれば、それに比例した確率
    probs = model.regret_match(np.array([2.0, 1.0, 5.0, 0.0, -3.0]), mask)
    assert probs[2] == 0.0, "打てない手は必ず 0"
    assert probs[0] == pytest.approx(2 / 3)
    assert probs[1] == pytest.approx(1 / 3)
    assert sum(probs) == pytest.approx(1.0)
    # 全部 0 以下なら一番マシな手。**同点なら均等に混ぜる**（ここを間違えると木が潰れる）
    even = model.regret_match(np.zeros(5), mask)
    assert even == [pytest.approx(0.25), pytest.approx(0.25), 0.0,
                    pytest.approx(0.25), pytest.approx(0.25)]
    one = model.regret_match(np.array([-1.0, -5.0, 0.0, -9.0, -2.0]), mask)
    assert one[0] == 1.0


def test_ソフトマックスは打てない手を選ばない():
    mask = [False, True, True, False, False]
    probs = model.masked_softmax(np.array([9.0, 1.0, 1.0, 9.0, 9.0]), mask)
    assert probs[0] == 0.0 and probs[3] == 0.0 and probs[4] == 0.0
    assert probs[1] == pytest.approx(0.5) and probs[2] == pytest.approx(0.5)


def test_木をたどると学習のもとが集まる():
    cfg = DeepConfig()
    zero = model.zero_net(deep_cfr.N_ACTIONS)
    out = deep_cfr.collect((zero, zero), 0, 30, seed=1, weight=1.0, cfg=cfg)
    assert len(out["adv_w"]) > 30, "1 局に 1 つ以上は後悔の材料が取れる"
    assert out["adv_x"].shape[1] == encoding.N_FEATURES
    assert out["adv_y"].shape[1] == deep_cfr.N_ACTIONS
    # 打てない手のところには後悔を入れない
    assert np.all(out["adv_y"][~out["adv_mask"]] == 0.0)
    # 後悔はスタックで割ってあるので、桁が大きくなりすぎない
    assert np.abs(out["adv_y"]).max() <= 2.0


def test_貯水池は決めた数を超えない():
    res = deep_cfr.Reservoir(100, 4, 3, seed=1)
    for _ in range(10):
        res.add(np.ones((50, 4), dtype=np.float16), np.ones((50, 3), dtype=np.float32),
                np.ones((50, 3), dtype=bool), np.ones(50, dtype=np.float32))
    assert len(res) == 100
    assert res.seen == 500
    x, y, mask, w = res.sample(20)
    assert len(x) == 20


def test_スタックの深さは毎回変わる():
    cfg = DeepConfig()
    rng = random.Random(1)
    stacks = {deep_cfr.sample_stack(rng, cfg) for _ in range(200)}
    assert len(stacks) > 50, "同じ深さばかりだと 1 つのネットで全部を扱う意味がない"
    assert min(stacks) >= cfg.min_stack_bb * 2 - 2
    assert max(stacks) <= cfg.max_stack_bb * 2 + 2


def test_ニューラルネットのプレイヤーは打てない手を選ばない():
    net = model.PokerNet(deep_cfr.N_ACTIONS, hidden=32, layers=2).to_numpy()
    policy = players.neural_player(net, seed=1)
    r = Rng(3)
    for i in range(40):
        st = deal(r, start_stack=200, button=i % 2)
        result = play_hand(st, (policy, policy), config.RAISE_FRACTIONS,
                           config.MAX_RAISES_PER_STREET)
        assert sum(result.payoff) == 0


def test_ネットは保存して読み直せる(tmp_path):
    net = model.PokerNet(deep_cfr.N_ACTIONS, hidden=32, layers=2)
    path = tmp_path / "net.pt"
    net.save(path, {"iteration": 3, "traversals": 1234})
    again, meta = model.PokerNet.load(path)
    assert meta["traversals"] == 1234
    x = np.zeros(encoding.N_FEATURES, dtype=np.float32)
    assert np.allclose(net.to_numpy()(x), again.to_numpy()(x))


def test_特徴量の版が違う重みは読めない(tmp_path, monkeypatch):
    """`encoding.py` を変えたのに古い重みを使う、という事故を防ぐ。"""
    net = model.PokerNet(deep_cfr.N_ACTIONS, hidden=16, layers=1)
    path = tmp_path / "old.pt"
    net.save(path)
    monkeypatch.setattr(model, "FEATURE_VERSION", encoding.FEATURE_VERSION + 1)
    with pytest.raises(ValueError):
        model.PokerNet.load(path)


def test_手の枠の数はルール側と一致する():
    from games.poker import rules

    assert deep_cfr.N_ACTIONS == rules.ACTION_COUNT
    st = _state()
    assert len(legal_mask(st, config.RAISE_FRACTIONS)) == deep_cfr.N_ACTIONS
