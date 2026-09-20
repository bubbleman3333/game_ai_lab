"""REST API と WebSocket のテスト。"""

import json

import pytest
from channels.testing import WebsocketCommunicator
from rest_framework.test import APIClient

from apps.training import services as training_services
from apps.training.models import Evaluation
from config.asgi import application


@pytest.fixture
def client():
    return APIClient()


@pytest.mark.django_db
def test_health(client):
    assert client.get("/api/health/").json() == {"status": "ok"}


@pytest.mark.django_db
def test_move_with_heuristic(client):
    res = client.post(
        "/api/tetris/move/",
        {"position": {"rows": [0x3FF & ~1] * 3, "current": "I", "next": ["T"]}, "agent": "heuristic"},
        format="json",
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["path"][-1] == "HD"
    assert body["expected"]["lines"] == 3  # 左端の縦穴に I を入れて 3 列消す


@pytest.mark.django_db
def test_move_validation_error_format(client):
    res = client.post("/api/tetris/move/", {"position": {"rows": [], "current": "X"}}, format="json")
    assert res.status_code == 400
    assert "error" in res.json()


@pytest.mark.django_db
def test_sync_runs_reads_jsonl(tmp_path, settings, client):
    run = tmp_path / "tetris" / "r1"
    run.mkdir(parents=True)
    (run / "config.json").write_text("{}")
    (run / "metrics.jsonl").write_text(
        "\n".join(json.dumps({"episode": i, "step": i * 10, "pieces": 10, "lines": i, "attack": 0}) for i in range(1, 6))
        + "\n"
    )
    settings.TRAINING_RUNS_DIR = tmp_path
    [r] = training_services.sync_all_runs(tmp_path)
    assert r.new_metrics == 5
    # 2 回目は増えた分だけ読む
    with open(run / "metrics.jsonl", "a") as f:
        f.write(json.dumps({"episode": 6, "step": 60, "pieces": 10, "lines": 6, "attack": 0}) + "\n")
    [r] = training_services.sync_all_runs(tmp_path)
    assert r.new_metrics == 1
    points = client.get("/api/training/runs/tetris/r1/metrics/?bucket=3").json()["points"]
    assert [p["episode"] for p in points] == [3, 6]
    assert points[1]["avg"]["lines"] == 5  # (4 + 5 + 6) / 3


@pytest.mark.django_db
def test_sync_runs_handles_rewritten_jsonl(tmp_path, settings):
    """evals.jsonl は `evaluate.py --save-run` で毎回上書きされる。

    前回読んだバイト位置がそのままだと行の途中から読んでしまうので、
    そうなったら頭から読み直すこと（読み直しても episode で上書きされるだけ）。
    """
    run = tmp_path / "tetris" / "baseline"
    run.mkdir(parents=True)
    (run / "config.json").write_text("{}")
    def row(extra):
        return json.dumps({"episode": 0, "score": 1.0, "results": {"solo": extra}}) + chr(10)

    (run / "evals.jsonl").write_text(row({"a": 1}))
    settings.TRAINING_RUNS_DIR = tmp_path
    [r] = training_services.sync_all_runs(tmp_path)
    assert r.new_evaluations == 1

    # 測り直して上書き（前より長い行になる = offset が行の途中を指す）
    (run / "evals.jsonl").write_text(row({"a": 1, "b": 2, "c": 3, "d": 4}))
    [r] = training_services.sync_all_runs(tmp_path)
    assert r.new_evaluations == 1
    assert Evaluation.objects.filter(run__name="baseline").count() == 1  # 二重に入らない
    assert Evaluation.objects.get(run__name="baseline").results["solo"] == {"a": 1, "b": 2, "c": 3, "d": 4}

    # 短くなる（行が減る）場合も読み直せる
    (run / "evals.jsonl").write_text(row({"a": 9}))
    [r] = training_services.sync_all_runs(tmp_path)
    assert Evaluation.objects.get(run__name="baseline").results["solo"] == {"a": 9}


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_online_match_flow():
    from apps.tetris_online.services import create_room
    from channels.db import database_sync_to_async

    room = await database_sync_to_async(create_room)()
    a = WebsocketCommunicator(application, f"/ws/tetris/rooms/{room.code}/?name=A", headers=[(b"origin", b"http://localhost")])
    b = WebsocketCommunicator(application, f"/ws/tetris/rooms/{room.code}/?name=B", headers=[(b"origin", b"http://localhost")])
    assert (await a.connect())[0]
    assert (await b.connect())[0]

    async def recv_until(c, kind):
        while True:
            msg = await c.receive_json_from(timeout=2)
            if msg["type"] == kind:
                return msg

    await a.send_json_to({"type": "ready", "ready": True})
    await b.send_json_to({"type": "ready", "ready": True})
    start = await recv_until(a, "start")
    assert (await recv_until(b, "start"))["seed"] == start["seed"]

    await a.send_json_to({"type": "attack", "lines": 4})
    assert (await recv_until(b, "garbage"))["lines"] == 4

    await b.send_json_to({"type": "topout", "stats": {}})
    assert (await recv_until(a, "end"))["winner_slot"] == 0
    await a.disconnect()
    await b.disconnect()


def _make_run(root, name: str, episode: int) -> None:
    """runs/tetris/<name>/ に best.pt と status.json だけ置く（中身は読まれない）。"""
    import json

    from rl.tetris.model import ValueNet, save_checkpoint

    d = root / "tetris" / name
    (d / "checkpoints").mkdir(parents=True)
    save_checkpoint(d / "checkpoints" / "best.pt", ValueNet(hidden=8, layers=1), {"episode": episode})
    (d / "status.json").write_text(json.dumps({"run_name": name, "episode": episode}), encoding="utf-8")


def test_default_agent_skips_a_run_that_just_started(tmp_path, settings):
    """学習を 2 つ同時に回すと、始めたばかりの run の best.pt がいちばん新しくなる。

    それを既定にすると、ほぼランダムな AI と対戦することになってしまう。
    """
    from apps.tetris_ai import agent_registry

    settings.TRAINING_RUNS_DIR = tmp_path
    _make_run(tmp_path, "old-and-strong", 30_000)
    _make_run(tmp_path, "just-started", 500)  # こちらのほうがファイルは新しい

    assert agent_registry.list_agents()[0].id == "just-started:best"  # 一覧は新しい順のまま
    assert agent_registry.default_agent_id() == "old-and-strong:best"


def test_default_agent_falls_back_when_every_run_is_young(tmp_path, settings):
    from apps.tetris_ai import agent_registry

    settings.TRAINING_RUNS_DIR = tmp_path
    _make_run(tmp_path, "young", 10)
    assert agent_registry.default_agent_id() == "young:best"


def test_default_agent_can_be_pinned(tmp_path, settings):
    """どの重みが強いかは自動では分からないので、総当たりで確かめた結果を指定できる。"""
    from apps.tetris_ai import agent_registry

    settings.TRAINING_RUNS_DIR = tmp_path
    _make_run(tmp_path, "weaker-but-newer", 30_000)
    _make_run(tmp_path, "stronger", 8_000)
    (tmp_path / "tetris" / "default_agent.txt").write_text("stronger:best", encoding="utf-8")

    assert agent_registry.default_agent_id() == "stronger:best"


def test_a_pin_that_no_longer_exists_is_ignored(tmp_path, settings):
    from apps.tetris_ai import agent_registry

    settings.TRAINING_RUNS_DIR = tmp_path
    _make_run(tmp_path, "only-run", 8_000)
    (tmp_path / "tetris" / "default_agent.txt").write_text("deleted-run:best", encoding="utf-8")

    assert agent_registry.default_agent_id() == "only-run:best"
