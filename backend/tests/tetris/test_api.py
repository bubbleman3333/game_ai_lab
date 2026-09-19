"""REST API と WebSocket のテスト。"""

import json

import pytest
from channels.testing import WebsocketCommunicator
from rest_framework.test import APIClient

from apps.training import services as training_services
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
