"""テトリス AI（rl/tetris/agent.py）のテスト。学習済みの重みは使わず、ランダムな重みで形だけ確かめる。"""

import torch

from games.tetris import Game
from rl.tetris.agent import NeuralAgent
from rl.tetris.config import RewardConfig
from rl.tetris.model import ValueNet
from rl.tetris.position import Position, enumerate_candidates, position_after


def _agent(lookahead: int) -> NeuralAgent:
    torch.manual_seed(0)
    return NeuralAgent(ValueNet(hidden=16, layers=1), 0.97, RewardConfig(), lookahead=lookahead)


def test_position_after_uses_next_piece_and_rest_of_queue():
    pos = Position.from_game(Game(seed=3))
    for c in enumerate_candidates(pos):
        nxt = position_after(c)
        assert nxt is not None
        if c.use_hold:  # ホールドが空なら NEXT の先頭を使うので、その次が出てくる
            assert nxt.current == pos.next[1] and nxt.next == pos.next[2:] and nxt.hold == pos.current
        else:
            assert nxt.current == pos.next[0] and nxt.next == pos.next[1:] and nxt.hold == pos.hold


def test_lookahead_agent_plays_legal_moves():
    g = Game(seed=5)
    agent = _agent(lookahead=1)
    for _ in range(30):
        if g.over:
            break
        c = agent.choose(Position.from_game(g))
        assert c is not None
        for a in c.path:
            g.apply(a)
    assert g.stats.pieces > 0


def test_lookahead_without_next_pieces_falls_back_to_one_ply():
    pos = Position.from_game(Game(seed=7))
    pos.next = []
    assert _agent(lookahead=1).choose(pos) is not None
