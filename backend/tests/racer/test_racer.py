"""レースのコース・物理のテスト。

TypeScript 版との一致は frontend/src/games/racer/engine/engine.test.ts で確かめる
（どちらも shared/fixtures/racer/engine_cases.json を読む）。ここでは Python 版だけで
「コースが破綻していないか」「走れるか」を見る。
"""

import json
import math
from pathlib import Path

import numpy as np
import pytest

from games.racer import course as CO
from games.racer import physics as P

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "racer" / "engine_cases.json"
COURSES = CO.course_ids()
CARS = P.car_ids()


def _curvature(c: CO.Course) -> np.ndarray:
    return CO._wrap_angle(np.roll(c.heading, -1) - np.roll(c.heading, 1)) / (2 * c.spacing)


# --- コース -------------------------------------------------------------------

@pytest.mark.parametrize("cid", COURSES)
def test_course_is_a_closed_loop(cid):
    """中心線が 1m ごとに並び、最後の点から最初の点へ自然につながっていること。"""
    c = CO.load(cid)
    d = np.sqrt((np.roll(c.x, -1) - c.x) ** 2 + (np.roll(c.y, -1) - c.y) ** 2
                + (np.roll(c.z, -1) - c.z) ** 2)
    ramp = c.kind == CO.KIND_RAMP  # ジャンプ台の終わりは崖なので、そこだけ間隔が開く
    assert np.allclose(d[~ramp], c.spacing, atol=0.15)
    assert 0.9 < c.spacing < 1.1
    assert 400 < c.length < 2000


@pytest.mark.parametrize("cid", COURSES)
def test_course_corners_are_drivable(cid):
    """曲がりが急すぎないこと。半径 20m を切ると、どの車でも曲がりきれない。"""
    radius = 1 / np.maximum(np.abs(_curvature(c := CO.load(cid))), 1e-9)
    assert radius.min() > 20, f"{cid}: 半径 {radius.min():.0f}m のコーナーがある"
    assert np.abs(c.bank).max() < 0.6


@pytest.mark.parametrize("cid", COURSES)
def test_course_features_are_placed(cid):
    """仕掛けがコースの上に乗っていて、復帰先が道の上にあること。"""
    c = CO.load(cid)
    assert (c.kind == CO.KIND_RAMP).any(), f"{cid}: ジャンプ台がない"
    assert (c.width >= 10).all()
    assert (c.kind[c.safe] != CO.KIND_GAP).all(), "落ちたときの復帰先が道の外にある"


def test_unknown_course_and_car_are_rejected():
    with pytest.raises(ValueError):
        CO.load("そんなコースはない")
    with pytest.raises(ValueError):
        P.load_car("そんな車はない")


# --- 物理 ---------------------------------------------------------------------

@pytest.mark.parametrize("cid", COURSES)
@pytest.mark.parametrize("car_id", CARS)
def test_heuristic_completes_laps(cid, car_id):
    """学習なしの運転者が、どの車でもどのコースでも 2 周できること。"""
    c, car = CO.load(cid), P.load_car(car_id)
    s = P.State.zeros(1)
    P.reset(s, np.ones(1, dtype=bool), c)
    laps = falls = 0
    for _ in range(60 * 180):
        ev = P.step(s, car, c, *P.heuristic_action(s, car, c))
        laps += int(ev["lapped"].sum())
        falls += int(ev["fell"].sum())
        if laps >= 2:
            break
    assert laps >= 2, f"{cid}/{car_id}: 2 周できなかった（{s.prog[0]:.0f}m）"
    assert falls == 0, f"{cid}/{car_id}: {falls} 回落ちた"


@pytest.mark.parametrize("cid", COURSES)
def test_car_stays_on_the_road(cid):
    """でたらめに操作しても、道からはみ出したまま走り続けないこと。"""
    c, car = CO.load(cid), P.load_car("balanced")
    n = 24
    rng = np.random.default_rng(0)
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), c, rng.integers(0, c.n, n),
            rng.uniform(-4, 4, n), rng.uniform(0, 40, n))
    for _ in range(60 * 20):
        P.step(s, car, c, rng.uniform(-1, 1, n), rng.uniform(-1, 1, n), rng.uniform(-1, 1, n))
        idx = s.seg.astype(np.int64)
        srx, srz = -np.cos(c.heading[idx]), np.sin(c.heading[idx])  # 運転者から見た右
        lateral = (s.x - c.x[idx]) * srx + (s.z - c.z[idx]) * srz
        # 接地している車は必ず道の幅に収まっている（飛んでいるあいだは外へ出てよい）
        on = s.on_ground > 0.5
        assert (np.abs(lateral[on]) <= c.width[idx][on] / 2 + 0.01).all()
        # どんな操作をしても空のかなたへ飛んでいかない
        assert (s.y < c.y[idx] + 80).all()


def test_slow_car_falls_into_the_gap_and_comes_back():
    """途切れた道に速度不足で突っ込むと落ち、少し手前の道の上に戻されること。"""
    c, car = CO.load("desert"), P.load_car("balanced")
    gap = int(np.argmax(c.kind == CO.KIND_GAP))
    s = P.State.zeros(1)
    P.reset(s, np.ones(1, dtype=bool), c, np.array([gap - 45]), np.array([0.0]), np.array([16.0]))
    fell = False
    for _ in range(60 * 12):
        ev = P.step(s, car, c, *P.heuristic_action(s, car, c, skill=0.5))
        if ev["fell"][0]:
            fell = True
            break
    assert fell, "遅い車が途切れた道を飛び越えてしまった"
    idx = int(s.seg[0])
    assert c.kind[idx] != CO.KIND_GAP
    assert s.respawn[0] > 0 and s.on_ground[0] == 1


def test_fast_car_clears_the_gap():
    """十分な速度があれば飛び越えられること。"""
    c, car = CO.load("desert"), P.load_car("speed")
    gap = int(np.argmax(c.kind == CO.KIND_GAP))
    s = P.State.zeros(1)
    P.reset(s, np.ones(1, dtype=bool), c, np.array([gap - 120]), np.array([0.0]), np.array([50.0]))
    for _ in range(60 * 10):
        ev = P.step(s, car, c, *P.heuristic_action(s, car, c))
        assert not ev["fell"][0], "速い車が途切れた道に落ちた"
        if s.prog[0] > 220:
            return
    pytest.fail("途切れた道の先まで進めなかった")


def test_ramp_launches_faster_cars_further():
    """同じジャンプ台でも、速く入るほど遠くまで飛ぶこと。"""
    c, car = CO.load("meadow"), P.load_car("balanced")
    ramp = int(np.argmax(c.kind == CO.KIND_RAMP))
    flights = []
    for speed in (20.0, 45.0):
        s = P.State.zeros(1)
        P.reset(s, np.ones(1, dtype=bool), c, np.array([ramp - 5]), np.array([0.0]), np.array([speed]))
        start = None
        for _ in range(60 * 8):
            P.step(s, car, c, np.array([1.0]), np.array([0.0]), np.array([-1.0]))
            if s.on_ground[0] < 0.5 and start is None:
                start = float(s.prog[0])
            elif s.on_ground[0] > 0.5 and start is not None:
                flights.append(float(s.prog[0]) - start)
                break
    assert len(flights) == 2
    # 丘の上のジャンプ台なので、落ちるまでの時間は速度によらずほぼ同じ。
    # そのぶん差は縮むが、それでも速いほうがはっきり遠くへ飛ぶ
    assert flights[1] > flights[0] * 1.2, f"飛距離が速度で伸びていない: {flights}"


def test_trick_gives_boost():
    """空中で半回転してから着地するとブーストがもらえること。"""
    c, car = CO.load("meadow"), P.load_car("balanced")
    ramp = int(np.argmax(c.kind == CO.KIND_RAMP))
    s = P.State.zeros(1)
    P.reset(s, np.ones(1, dtype=bool), c, np.array([ramp - 15]), np.array([0.0]), np.array([44.0]))
    tricks = 0
    for _ in range(60 * 6):
        in_air = s.on_ground[0] < 0.5
        steer = np.array([1.0]) if in_air else np.array([0.0])
        ev = P.step(s, car, c, np.array([1.0]), steer, np.array([-1.0]))
        if ev["tricks"][0] > 0:
            tricks += int(ev["tricks"][0])
            assert s.boost[0] > 0, "トリックを決めたのにブーストがつかない"
    assert tricks >= 1, "半回転して着地できなかった"


def test_lap_is_not_counted_twice():
    """スタート線の上で前後に往復しても、周回が増え続けないこと。"""
    c, car = CO.load("meadow"), P.load_car("balanced")
    s = P.State.zeros(1)
    P.reset(s, np.ones(1, dtype=bool), c)
    s.prog[0] = c.length - 3.0  # ゴール線の直前まで進んだことにする
    s.lap[0] = 0.0
    laps = 0
    for i in range(60 * 20):  # 前へ進んだり戻ったりを繰り返す
        drive = 1.0 if (i // 45) % 2 == 0 else -1.0
        ev = P.step(s, car, c, np.array([drive]), np.array([0.0]), np.array([-1.0]))
        laps += int(ev["lapped"].sum())
    assert laps == 1, f"往復で周回が {laps} 回数えられた"


# --- 観測 ---------------------------------------------------------------------

def test_observation_shape_and_range():
    """AI に渡す観測が、決めた個数でそろっていて、極端な値にならないこと。"""
    c, car = CO.load("desert"), P.load_car("balanced")
    n = 32
    rng = np.random.default_rng(1)
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), c, rng.integers(0, c.n, n),
            rng.uniform(-6, 6, n), rng.uniform(0, 50, n))
    for _ in range(300):
        P.step(s, car, c, rng.uniform(-1, 1, n), rng.uniform(-1, 1, n), rng.uniform(-1, 1, n))
        obs = P.observe(s, car, c)
        assert obs.shape == (n, P.OBS_DIM)
        assert np.isfinite(obs).all()
        assert np.abs(obs).max() < 6


# --- テストデータ ---------------------------------------------------------------

def test_fixture_file_covers_everything():
    """TypeScript と突き合わせるデータが、起きうる出来事を一通り含んでいること。"""
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    assert [c["id"] for c in data["courses"]] == COURSES
    assert [c["id"] for c in data["cars"]] == CARS
    total: dict[str, float] = {}
    for run in data["runs"]:
        for step in run["steps"]:
            for k, v in step["ev"].items():
                total[k] = total.get(k, 0) + sum(v)
    for k in ("landed", "tricks", "fell", "hit"):
        assert total.get(k, 0) > 0, f"テストデータに {k} が 1 回も出てこない"


def test_fixture_replay_matches_python():
    """記録した入力をもう一度流して、同じ結果になること（データが古くなっていない確認）。"""
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    for run in data["runs"]:
        c, car = CO.load(run["course"]), P.load_car(run["car"])
        s = P.State(*(np.array([st[f] for st in run["initial"]]) for f in P.FIELDS))
        for step in run["steps"]:
            a = np.array(step["in"])
            P.step(s, car, c, a[:, 0], a[:, 1], a[:, 2])
            if "state" in step:
                for f in P.FIELDS:
                    assert np.allclose(getattr(s, f), [st[f] for st in step["state"]], atol=1e-6), \
                        f"{run['course']}: {f} が合わない（fixtures を作り直してください）"


# --- API ----------------------------------------------------------------------

@pytest.mark.django_db
def test_result_save_and_summary():
    """走行結果を保存して、コース・車ごとにまとめて読めること。"""
    from rest_framework.test import APIClient
    c = APIClient()
    body = {"course": COURSES[0], "car": CARS[0], "agent": "なし", "laps": 3,
            "total_sec": 72.5, "best_lap_sec": 23.4, "tricks": 2, "falls": 0,
            "place": 1, "racers": 2}
    assert c.post("/api/racer/results/", body, format="json").status_code == 201
    assert c.post("/api/racer/results/", {**body, "best_lap_sec": 21.9, "place": 2},
                  format="json").status_code == 201
    [row] = c.get("/api/racer/results/summary/").json()
    assert row["course"] == COURSES[0] and row["runs"] == 2
    assert row["best_lap"] == pytest.approx(21.9)
    assert row["wins"] == 1 and row["losses"] == 1


@pytest.mark.django_db
@pytest.mark.parametrize("bad,code", [
    ({"course": "ない"}, "unknown_course"),
    ({"car": "ない"}, "unknown_car"),
    ({"best_lap_sec": 999.0}, "invalid_time"),
    ({"place": 5, "racers": 2}, "invalid_place"),
])
def test_result_rejects_bad_input(bad, code):
    from rest_framework.test import APIClient
    body = {"course": COURSES[0], "car": CARS[0], "agent": "なし", "laps": 3,
            "total_sec": 72.5, "best_lap_sec": 23.4, "place": 1, "racers": 2}
    res = APIClient().post("/api/racer/results/", {**body, **bad}, format="json")
    assert res.status_code >= 400
    assert res.json()["error"]["code"] == code


@pytest.mark.django_db
def test_agents_lists_heuristic_when_nothing_is_trained(tmp_path, settings):
    """学習した AI がまだ無いときは、学習なしの運転者だけが返ること。"""
    from rest_framework.test import APIClient
    settings.TRAINING_RUNS_DIR = tmp_path
    rows = APIClient().get("/api/racer/agents/").json()
    assert [r["id"] for r in rows] == ["heuristic"]
    # 学習なしの運転者はブラウザに組み込み済みなので、重みは配らない
    assert APIClient().get("/api/racer/agents/heuristic/policy/").status_code == 404


@pytest.mark.django_db
def test_trained_agent_becomes_default_once_it_is_faster(tmp_path, settings):
    """学習した AI は、学習なしより速くなってはじめて既定（先頭）になること。"""
    from rest_framework.test import APIClient
    settings.TRAINING_RUNS_DIR = tmp_path
    ckpt = tmp_path / "racer" / "v9" / "checkpoints"
    ckpt.mkdir(parents=True)
    (ckpt / "best.json").write_text(
        json.dumps({"version": 1, "activation": "tanh", "layers": []}), encoding="utf-8")
    evals = tmp_path / "racer" / "v9" / "evals.jsonl"

    def write_eval(score: float) -> None:
        evals.write_text(json.dumps({"is_best": True, "score": score}) + "\n", encoding="utf-8")

    # まだ学習なしより遅い（速さの比が 1 未満）なら、学習なしが先頭のまま
    write_eval(0.9)
    assert APIClient().get("/api/racer/agents/").json()[0]["id"] == "heuristic"

    # 速くなったら先頭が入れ替わる
    write_eval(1.05)
    rows = APIClient().get("/api/racer/agents/").json()
    assert rows[0]["id"] == "v9:best"
    assert APIClient().get("/api/racer/agents/v9:best/policy/").json()["version"] == 1
