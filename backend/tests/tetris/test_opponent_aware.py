"""相手の盤面を見る特徴量（docs/TETRIS_OPPONENT_AWARE.md）のテスト。

いちばん大事なのは「**特徴量を増やしても古い重みが動き続ける**」こと。
"""

import pytest
import torch

from games.tetris import Game
from rl.tetris.agent import NeuralAgent
from rl.tetris.config import RewardConfig, TrainConfig
from rl.tetris.encoding import (
    FEATURE_DIMS, FEATURE_NAMES_BY_VERSION, FEATURE_VERSION, encode, encode_many,
)
from rl.tetris.env import VersusEnv
from rl.tetris.model import ValueNet, load_checkpoint, save_checkpoint
from rl.tetris.position import OpponentView, Position, enumerate_candidates, position_after
from rl.tetris.train import play_versus_episode


def _cands(opponent=None):
    pos = Position.from_game(Game(seed=3), opponent)
    return pos, enumerate_candidates(pos)


# --- 特徴量のバージョン ---------------------------------------------------------------

def test_version_1_is_unchanged_and_version_2_adds_the_opponent():
    assert FEATURE_DIMS == {1: 43, 2: 52}
    v1, v2 = FEATURE_NAMES_BY_VERSION[1], FEATURE_NAMES_BY_VERSION[2]
    assert v2[:43] == v1  # 古い特徴量はそのままの並びで先頭に残す
    assert v2[43:] == [
        "opp_present", "opp_max_height", "opp_agg_height", "opp_holes", "opp_bumpiness",
        "opp_pending", "opp_margin", "opp_combo", "opp_b2b",
    ]


def test_encoding_version_1_ignores_the_opponent():
    _, without = _cands()
    _, with_opp = _cands(OpponentView(max_height=15, pending=8))
    assert encode(without[0], 1) == pytest.approx(encode(with_opp[0], 1))
    assert len(encode(with_opp[0], 1)) == 43


def test_solo_play_is_marked_by_opp_present():
    _, cands = _cands()
    assert encode(cands[0], 2)[43:] == pytest.approx([0] * 9)  # opp_present = 0
    _, with_opp = _cands(OpponentView(max_height=5))
    assert encode(with_opp[0], 2)[43] == pytest.approx(1.0)


def test_encode_many_uses_the_requested_version():
    _, cands = _cands(OpponentView(max_height=5))
    assert encode_many(cands, 1).shape == (len(cands), 43)
    assert encode_many(cands, 2).shape == (len(cands), 52)
    assert encode_many([], 2).shape == (0, 52)


# --- 「この手を打った後」の相手 ---------------------------------------------------------

def test_attack_sent_is_added_to_the_opponents_pending():
    """畳みかけを学ぶ肝。候補手の評価では、送った分を乗せた後の相手を見る。"""
    opp = OpponentView(max_height=10, pending=2)
    _, cands = _cands(opp)
    attacker = max(cands, key=lambda c: c.outcome.sent)
    assert attacker.outcome.sent >= 0
    assert attacker.opponent_after().pending == opp.pending + attacker.outcome.sent


def test_opp_margin_is_how_close_the_opponent_is_to_dying():
    _, cands = _cands(OpponentView(max_height=14, pending=4))
    c = next(c for c in cands if c.outcome.sent == 0)
    margin = encode(c, 2)[43 + 6] * 20  # opp_margin は 20 で割ってある
    assert margin == pytest.approx(20 - (14 + 4))


def test_opp_margin_never_goes_below_zero():
    _, cands = _cands(OpponentView(max_height=18, pending=10))
    assert encode(cands[0], 2)[43 + 6] == pytest.approx(0.0)


def test_lookahead_carries_the_opponent_forward():
    """先読みの先でも、送った分を積み上げた相手が見えている。"""
    _, cands = _cands(OpponentView(max_height=10, pending=0))
    c = next(c for c in cands if not c.dead and c.next_after)
    nxt = position_after(c)
    assert nxt.opponent.pending == c.outcome.sent


# --- 古い重みが動き続けること -----------------------------------------------------------

def test_old_checkpoint_loads_with_its_own_encoder(tmp_path):
    """特徴量バージョン 1 の重みは、43 次元のまま読み込めて手も選べる。"""
    path = tmp_path / "old.pt"
    torch.save(
        {"state_dict": ValueNet(43, hidden=16, layers=1).state_dict(),
         "feature_version": 1, "hidden": 16, "layers": 1, "meta": {"episode": 42}},
        path,
    )
    model, meta = load_checkpoint(path)
    assert meta["feature_version"] == 1
    assert model.net[0].in_features == 43

    agent = NeuralAgent.load(path)
    assert agent.feature_version == 1
    assert agent.choose(Position.from_game(Game(seed=1), OpponentView(max_height=9))) is not None


def test_new_checkpoint_round_trips_at_the_current_version(tmp_path):
    path = tmp_path / "new.pt"
    save_checkpoint(path, ValueNet(hidden=16, layers=1), {"episode": 1})
    model, meta = load_checkpoint(path)
    assert meta["feature_version"] == FEATURE_VERSION
    assert model.net[0].in_features == FEATURE_DIMS[FEATURE_VERSION]


def test_unknown_feature_version_is_rejected(tmp_path):
    path = tmp_path / "future.pt"
    torch.save({"state_dict": {}, "feature_version": 99, "hidden": 16, "layers": 1, "meta": {}}, path)
    with pytest.raises(ValueError, match="99"):
        load_checkpoint(path)


# --- 相手の情報の作り方 ---------------------------------------------------------------

def test_opponent_view_from_game_and_dict_agree():
    g = Game(seed=8)
    g.receive_garbage(3)
    from_game = OpponentView.from_game(g)
    from_dict = OpponentView.from_dict(
        {"rows": g.board.rows, "pending": [list(p) for p in g.pending], "combo": g.combo, "b2b": g.b2b}
    )
    assert from_game == from_dict
    assert from_game.pending == 3


def test_versus_env_shows_each_side_the_other():
    env = VersusEnv(max_pieces=50, seed=2)
    env.games[1].receive_garbage(5)
    assert env.position(0).opponent.pending == 5
    assert env.position(1).opponent.pending == 0


# --- 勝ったときの報酬 -----------------------------------------------------------------

class _Suicide:
    """すぐ死ぬように積む側（勝敗をはっきりさせるため）。"""

    def choose_index(self, cands):
        from games.tetris.features import board_features

        return max(range(len(cands)), key=lambda i: board_features(cands[i].outcome.board).max_height)


def test_the_winner_gets_a_terminal_transition():
    """相手は自分の手番で死ぬので、勝った側には終端の遷移を別に流す必要がある。"""
    env = VersusEnv(max_pieces=400, seed=1)
    rows = []
    cfg = TrainConfig(run_name="t", max_pieces=400, eps_start=1.0, eps_end=1.0, eps_decay_episodes=1,
                      reward=RewardConfig(win=5.0))
    torch.manual_seed(0)
    row = play_versus_episode(env, ValueNet(hidden=16, layers=1), cfg, 1, torch.device("cpu"),
                              lambda s, r, s2, d: rows.append((r, d)))
    if row["won"] or env.games[1].over or env.games[0].over:
        wins = [r for r, d in rows if d and r == pytest.approx(5.0)]
        assert len(wins) == 1  # 勝ったのは 1 人だけ


def test_win_reward_can_be_turned_off():
    env = VersusEnv(max_pieces=200, seed=1)
    rows = []
    cfg = TrainConfig(run_name="t", max_pieces=200, eps_start=1.0, eps_end=1.0, eps_decay_episodes=1,
                      reward=RewardConfig(win=0.0))
    torch.manual_seed(0)
    play_versus_episode(env, ValueNet(hidden=16, layers=1), cfg, 1, torch.device("cpu"),
                        lambda s, r, s2, d: rows.append((r, d)))
    assert not [r for r, d in rows if r == pytest.approx(5.0)]
