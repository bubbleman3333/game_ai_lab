"""ブロブチェインのオンライン部屋（テトリスと同じ仕組みを game="blob" で使う）。"""

import pytest
from channels.testing import WebsocketCommunicator
from rest_framework.test import APIClient

from config.asgi import application

ORIGIN = [(b"origin", b"http://localhost")]


@pytest.mark.django_db
def test_blob_rooms_are_separate_from_tetris():
    client = APIClient()
    blob = client.post("/api/blob/rooms/").json()
    tetris = client.post("/api/tetris/rooms/").json()
    assert client.get(f"/api/blob/rooms/{blob['code']}/").status_code == 200
    assert client.get(f"/api/blob/rooms/{tetris['code']}/").status_code == 404
    assert client.get(f"/api/tetris/rooms/{blob['code']}/").status_code == 404


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_blob_match_flow_and_wrong_game():
    from channels.db import database_sync_to_async

    from apps.tetris_online.services import create_room

    room = await database_sync_to_async(create_room)("blob")
    # テトリスの入口からはブロブの部屋に入れない
    wrong = WebsocketCommunicator(application, f"/ws/tetris/rooms/{room.code}/?name=X", headers=ORIGIN)
    assert (await wrong.connect())[0]
    assert (await wrong.receive_json_from(timeout=2))["type"] == "error"
    assert (await wrong.receive_output(timeout=2)) == {"type": "websocket.close", "code": 4004}
    await wrong.disconnect()

    a = WebsocketCommunicator(application, f"/ws/blob/rooms/{room.code}/?name=A", headers=ORIGIN)
    b = WebsocketCommunicator(application, f"/ws/blob/rooms/{room.code}/?name=B", headers=ORIGIN)
    assert (await a.connect())[0]
    assert (await b.connect())[0]

    async def recv_until(c, kind):
        while True:
            msg = await c.receive_json_from(timeout=2)
            if msg["type"] == kind:
                return msg

    await a.send_json_to({"type": "ready", "ready": True})
    await b.send_json_to({"type": "ready", "ready": True})
    await recv_until(a, "start")
    await recv_until(b, "start")
    rows = ["120000"] + ["000000"] * 12
    await a.send_json_to({"type": "state", "rows": rows, "stats": {"pieces": 1, "lines": 0, "attack": 0}, "pending": 0})
    assert (await recv_until(b, "opponent_state"))["rows"] == rows
    await a.send_json_to({"type": "attack", "lines": 30})
    assert (await recv_until(b, "garbage"))["lines"] == 30
    await b.send_json_to({"type": "topout", "stats": {}})
    assert (await recv_until(a, "end"))["winner_slot"] == 0
    await a.disconnect()
    await b.disconnect()
