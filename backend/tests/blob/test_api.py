"""ブロブチェイン AI の API（apps/blob_ai）のテスト。"""

import pytest
from rest_framework.test import APIClient

from games.blob import BlobGame, W
from rl.blob.position import Position


@pytest.fixture
def client():
    return APIClient()


@pytest.mark.django_db
def test_agents_にはヒューリスティックが必ず入る(client):
    res = client.get("/api/blob/agents/")
    assert res.status_code == 200
    ids = [a["id"] for a in res.json()]
    assert "heuristic" in ids


@pytest.mark.django_db
def test_move_は操作列を返す(client):
    res = client.post(
        "/api/blob/move/",
        {"position": {"rows": ["111000", "200000"], "current": [1, 2], "next": [[3, 4], [2, 2]]},
         "agent": "heuristic"},
        format="json",
    )
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["agent"] == "heuristic"
    assert body["path"][-1] == "HD"
    assert 0 <= body["placement"]["x"] < W and body["placement"]["rot"] in (0, 1, 2, 3)
    assert set(body["expected"]) == {"chain", "score", "sent", "cancelled", "all_clear", "dead"}


@pytest.mark.django_db
def test_返ってきた操作列をエンジンで実行すると同じ場所に置かれる(client):
    """ブラウザ側はこの操作列をそのまま実行するので、ここがずれると AI が思わぬ場所に置く。"""
    g = BlobGame(seed=11)
    for x, n in enumerate([3, 1, 0, 2, 5, 1]):  # でこぼこな盤面にしておく
        for y in range(n):
            g.field.set(x, y, (x + y) % 4 + 1)
    pos = Position.from_game(g)
    res = client.post(
        "/api/blob/move/",
        {"position": {"rows": ["".join(str(g.field.get(x, y)) for x in range(W)) for y in range(13)],
                      "current": list(pos.current), "next": [list(p) for p in pos.next]},
         "agent": "heuristic"},
        format="json",
    )
    assert res.status_code == 200, res.content
    body = res.json()
    for a in body["path"]:
        if a == "L":
            g.move(-1)
        elif a == "R":
            g.move(1)
        elif a == "CW":
            g.rotate(1)
        elif a == "CCW":
            g.rotate(-1)
        elif a == "HD":
            g.hard_drop()
    assert g.current.x == body["placement"]["x"]
    assert g.current.rot == body["placement"]["rot"]
    result = (g.lock(), g.resolve())[1]
    assert result.chain == body["expected"]["chain"]
    assert result.sent == body["expected"]["sent"]


@pytest.mark.django_db
def test_入力の誤りは400(client):
    res = client.post("/api/blob/move/", {"position": {"rows": ["1x0000"], "current": [1, 2]}}, format="json")
    assert res.status_code == 400
    assert "error" in res.json()


@pytest.mark.django_db
def test_知らないAIは404(client):
    res = client.post(
        "/api/blob/move/",
        {"position": {"rows": ["000000"], "current": [1, 2]}, "agent": "no-such-run:best"},
        format="json",
    )
    assert res.status_code == 404


@pytest.mark.django_db
def test_ゲームオーバーの局面は422(client):
    rows = ["".join(str((x + y) % 4 + 1) for x in range(W)) for y in range(13)]
    res = client.post("/api/blob/move/", {"position": {"rows": rows, "current": [1, 2]}}, format="json")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "no_move"


@pytest.mark.django_db
def test_オンライン対戦の部屋と同じ入口でぶつからない(client):
    """/api/blob/ には対戦の部屋（apps/tetris_online）も相乗りしている。"""
    assert client.post("/api/blob/rooms/").status_code == 201
    assert client.get("/api/blob/agents/").status_code == 200
