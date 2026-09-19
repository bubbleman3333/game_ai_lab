"""エアホッケーの物理と API のテスト。"""

import json
from pathlib import Path

import numpy as np
import pytest
from rest_framework.test import APIClient

from games.airhockey import physics as P

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "airhockey" / "engine_cases.json"


def test_fixture_replay():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    s = P.State(*(np.array([st[f] for st in data["initial"]]) for f in P.FIELDS))
    for step in data["steps"]:
        a0 = np.array(step["a0"])
        h1x, h1y = P.heuristic_action(s, 1)
        goal = P.step(s, a0[:, 0], a0[:, 1], h1x, h1y)
        assert goal.tolist() == step["goal"]
        for f in P.FIELDS:
            assert np.allclose(getattr(s, f), [st[f] for st in step["state"]])
        done = goal != 0
        if done.any():  # fixtures.py と同じく、得点が入った台は初期配置に戻す
            P.reset(s, done, np.zeros(len(goal), dtype=int))


def test_heuristic_is_balanced():
    rng = np.random.default_rng(0)
    n = 200
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), rng.integers(0, 2, n), rng)
    goals = np.zeros(n)
    for _ in range(60 * 15):
        a0, a1 = P.heuristic_action(s, 0), P.heuristic_action(s, 1)
        goals = np.where(goals == 0, P.step(s, *a0, *a1), goals)
    p0 = int((goals > 0).sum())
    assert 60 < p0 < 140  # 同じ AI どうしならだいたい五分


@pytest.mark.django_db
def test_match_save_and_summary():
    c = APIClient()
    res = c.post("/api/airhockey/matches/", {"agent": "heuristic", "level": "max", "human_score": 7, "ai_score": 3},
                 format="json")
    assert res.status_code == 201
    [row] = c.get("/api/airhockey/matches/summary/").json()
    assert row["human_wins"] == 1 and row["human_points"] == 7
