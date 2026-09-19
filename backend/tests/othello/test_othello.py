"""オセロのエンジン・評価関数・API のテスト。"""

import json
import random
from pathlib import Path

import numpy as np
import pytest
from rest_framework.test import APIClient

from games.othello.board import Position, bits, play_moves, popcount, sq_to_str
from rl.othello.ntuple import N_STAGES, TABLE_SIZE, NTupleNet
from rl.othello.players import PositionalPlayer, RandomPlayer
from rl.othello.evaluate import match

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "othello" / "engine_cases.json"


def test_initial_moves():
    assert sorted(sq_to_str(s) for s in bits(Position.initial().moves())) == ["c4", "d3", "e6", "f5"]


def test_fixture_games_replay():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    for g in data["games"]:
        pos = play_moves(g["moves"])
        assert pos.is_over()
        assert pos.to_strings() == g["final_board"]
        assert pos.final_score() == g["final_score_for_side_to_move"]


def test_play_moves_rejects_illegal():
    with pytest.raises(ValueError):
        play_moves("a1")


def test_ntuple_update_moves_value_toward_target():
    net = NTupleNet()
    pos = Position.initial().play(37)  # f5
    target = 0.3
    for _ in range(50):
        net.update(pos, 0.05 * (target - net.evaluate(pos)))
    assert net.evaluate(pos) == pytest.approx(target, abs=1e-3)


def test_positional_beats_random():
    res = match(PositionalPlayer(1, 0), RandomPlayer(0), pairs=10)
    assert res["win_rate"] > 0.6


@pytest.mark.django_db
def test_save_game_and_summary():
    # ランダムに最後まで打った棋譜を保存できる
    rng = random.Random(1)
    pos, moves = Position.initial(), ""
    while not pos.is_over():
        sq = rng.choice(list(bits(pos.moves())))
        moves += sq_to_str(sq)
        pos = pos.play(sq).normalize()
    client = APIClient()
    res = client.post("/api/othello/games/", {"moves": moves, "human_color": "black", "agent": "positional",
                                              "level": "max"}, format="json")
    assert res.status_code == 201, res.content
    assert res.json()["black_discs"] == popcount(pos.black)
    [row] = client.get("/api/othello/games/summary/").json()
    assert row["games"] == 1


@pytest.mark.django_db
def test_save_game_rejects_unfinished():
    res = APIClient().post("/api/othello/games/", {"moves": "f5d6", "human_color": "black", "agent": "x",
                                                   "level": "max"}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "not_finished"


@pytest.mark.django_db
def test_weights_endpoint(tmp_path, settings):
    ckpt = tmp_path / "othello" / "r1" / "checkpoints"
    NTupleNet(np.full((N_STAGES, TABLE_SIZE), 0.25, dtype=np.float32)).save(ckpt / "best.npz", {})
    settings.TRAINING_RUNS_DIR = tmp_path
    client = APIClient()
    ids = [a["id"] for a in client.get("/api/othello/agents/").json()]
    assert ids[0] == "r1:best" and "positional" in ids
    res = client.get("/api/othello/agents/r1:best/weights/")
    w = np.frombuffer(res.content, dtype="<f4")
    assert w.size == N_STAGES * TABLE_SIZE and w[0] == 0.25
    assert client.get("/api/othello/spec/").json()["table_size"] == TABLE_SIZE
