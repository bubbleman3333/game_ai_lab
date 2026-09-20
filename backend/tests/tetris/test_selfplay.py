"""自己対戦での学習（rl/tetris/env.py の VersusEnv と train.py の play_versus_episode）のテスト。"""

import torch

from rl.tetris.agent import HeuristicAgent
from rl.tetris.config import TrainConfig
from rl.tetris.env import VersusEnv
from rl.tetris.model import ValueNet
from rl.tetris.train import play_versus_episode, use_selfplay


def _model() -> ValueNet:
    torch.manual_seed(0)
    return ValueNet(hidden=16, layers=1)


def _cfg(**kw) -> TrainConfig:
    return TrainConfig(run_name="test", max_pieces=20, eps_start=1.0, eps_end=1.0,
                       eps_decay_episodes=1, **kw)


def test_both_sides_start_with_the_same_queue():
    env = VersusEnv(max_pieces=50, seed=11)
    assert env.position(0).next == env.position(1).next


def test_attack_becomes_the_opponents_garbage():
    """火力を出したら、その段数がそのまま相手の pending に積まれる。"""
    env = VersusEnv(max_pieces=300, seed=4)
    agent = HeuristicAgent()
    sent_total = 0
    while not env.done:
        side = env.turn
        c = agent.choose(env.position(side))
        if c is None:
            break
        before = sum(p[0] for p in env.games[1 - side].pending)
        result = env.step(side, c)
        after = sum(p[0] for p in env.games[1 - side].pending)
        if result.sent > 0:
            assert after - before == result.sent  # 送った段数がそのまま相手に積まれる
            sent_total += result.sent
    assert sent_total > 0


def test_turn_alternates():
    env = VersusEnv(max_pieces=50, seed=6)
    assert env.turn == 0
    env.step(0, env.candidates(0)[0])
    assert env.turn == 1
    env.step(1, env.candidates(1)[0])
    assert env.turn == 0


def test_reset_can_choose_who_plays_first():
    env = VersusEnv(max_pieces=50, seed=6)
    env.reset(6, first=1)
    assert env.turn == 1


def test_versus_episode_collects_experience_from_both_sides():
    env = VersusEnv(max_pieces=20, seed=0)
    rows = []
    play_versus_episode(env, _model(), _cfg(), 1, torch.device("cpu"),
                        lambda s, r, s2, d: rows.append((s, r, s2, d)))
    # 1 局で 2 人分たまるので、片側の手数よりはっきり多くなる
    assert len(rows) > env.games[0].stats.pieces


def test_versus_episode_reports_the_result():
    env = VersusEnv(max_pieces=20, seed=0)
    row = play_versus_episode(env, _model(), _cfg(), 1, torch.device("cpu"), lambda *a: None)
    assert row["selfplay"] is True
    assert row["pieces"] > 0
    assert isinstance(row["won"], bool)
    assert not (row["won"] and row["died"])


def test_selfplay_starts_at_the_configured_episode():
    cfg = _cfg(selfplay_start=100)
    assert not use_selfplay(cfg, 99)
    assert use_selfplay(cfg, 100)


def test_selfplay_can_be_turned_off():
    cfg = _cfg(selfplay_start=-1)
    assert not use_selfplay(cfg, 0)
    assert not use_selfplay(cfg, 100_000)
