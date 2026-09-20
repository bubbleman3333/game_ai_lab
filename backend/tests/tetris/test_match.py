"""AI 同士の対戦（rl/tetris/match.py）のテスト。学習済みの重みは使わない。"""

import pytest
import torch

from games.tetris import Game
from games.tetris.features import board_features
from rl.tetris.agent import HeuristicAgent, NeuralAgent
from rl.tetris.config import RewardConfig
from rl.tetris.evaluate import strength_score
from rl.tetris.match import match, play_match
from rl.tetris.model import ValueNet
from rl.tetris.position import Position, enumerate_candidates


class _StackingAgent:
    """わざと高く積んで早く負ける AI（対戦がちゃんと終わることを確かめるため）。"""

    name = "stacker"

    def choose(self, pos: Position):
        cands = enumerate_candidates(pos)
        return max(cands, key=lambda c: board_features(c.outcome.board).max_height) if cands else None


def _neural(seed: int = 0) -> NeuralAgent:
    torch.manual_seed(seed)
    return NeuralAgent(ValueNet(hidden=16, layers=1), 0.97, RewardConfig())


def test_both_sides_get_the_same_piece_queue():
    """オンライン対戦と同じく、両者のツモ順は同じ（同じ seed を配る）。"""
    assert Game(seed=42).next_pieces == Game(seed=42).next_pieces


def test_match_ends_and_names_a_winner():
    r = play_match(HeuristicAgent(), _StackingAgent(), seed=1, max_pieces=200)
    assert r.winner == 0  # 積み続ける側が先に死ぬ
    assert r.pieces[0] > 0 and r.pieces[1] > 0


def test_match_is_a_draw_when_both_survive():
    r = play_match(HeuristicAgent(), HeuristicAgent(), seed=2, max_pieces=12)
    assert r.winner is None


def test_attack_is_sent_to_the_opponent():
    """片方が火力を出したら、相手にせり上がりが溜まる（versus.ts と同じ扱い）。"""
    r = play_match(HeuristicAgent(), HeuristicAgent(), seed=3, max_pieces=120)
    assert r.attack[0] + r.attack[1] > 0


def test_match_swaps_the_order_and_reports_a_win_rate():
    res = match(HeuristicAgent(), _StackingAgent(), games=4, max_pieces=150)
    assert res["games"] == 4
    assert res["win_rate"] == pytest.approx(1.0)  # 打つ順番を入れ替えても勝てる
    assert res["avg_pieces"] > 0


def test_win_rate_counts_a_draw_as_half():
    res = match(HeuristicAgent(), HeuristicAgent(), games=2, max_pieces=10)
    assert res["draw_rate"] == pytest.approx(1.0)
    assert res["win_rate"] == pytest.approx(0.5)


def test_strength_score_prefers_the_win_rate():
    """対戦の結果があれば、ひとり遊びの数値ではなく勝率（0〜100）を使う。"""
    solo_only = {"solo": {"avg_attack": 100.0, "avg_lines": 100.0}}
    with_versus = {"solo": {"avg_attack": 0.0, "avg_lines": 0.0}, "vs_heuristic": {"win_rate": 0.75}}
    assert strength_score(solo_only) == pytest.approx(110.0)
    assert strength_score(with_versus) == pytest.approx(75.0)


def test_neural_agent_can_play_a_match():
    r = play_match(_neural(0), _neural(1), seed=5, max_pieces=30)
    assert r.pieces[0] > 0 and r.pieces[1] > 0
