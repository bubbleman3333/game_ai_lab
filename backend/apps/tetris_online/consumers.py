"""オンライン対戦の WebSocket（Controller 層）。メッセージの形は protocol.py を参照。

DB を触る処理はすべて services.py に任せ、ここではメッセージの受け渡しだけをする。
"""

from __future__ import annotations

from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.common.errors import DomainError

from . import protocol as P
from . import selectors, services


@database_sync_to_async
def _room_state_by_code(code: str) -> dict:
    return selectors.room_state(selectors.get_room(code))


class RoomConsumer(AsyncJsonWebsocketConsumer):
    player_id: int | None = None
    slot: int | None = None
    code: str = ""

    @property
    def group(self) -> str:
        return f"room_{self.code}"

    # --- 接続・切断 -----------------------------------------------------------
    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"].upper()
        self.game = self.scope["url_route"]["kwargs"].get("game", "tetris")
        query = parse_qs(self.scope.get("query_string", b"").decode())
        name = query.get("name", [""])[0]
        await self.accept()
        try:
            player = await database_sync_to_async(services.join_room)(self.code, name, self.channel_name, self.game)
        except DomainError as e:
            await self._send_error(e.code, str(e))
            await self.close(code=P.CLOSE_ROOM_FULL if e.code == "room_full" else P.CLOSE_ROOM_NOT_FOUND)
            return
        self.player_id, self.slot = player.id, player.slot
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.send_json({"type": P.S_WELCOME, "slot": self.slot})
        await self._broadcast_room()

    async def disconnect(self, close_code):
        if self.player_id is None:
            return
        await self.channel_layer.group_discard(self.group, self.channel_name)
        room, end = await database_sync_to_async(services.leave_room)(self.player_id)
        self.player_id = None
        if room is None:
            return
        state = await database_sync_to_async(selectors.room_state)(room)
        if end is not None:
            await self._group_send({"type": P.S_END, "winner_slot": end.winner_slot, "reason": end.reason, "room": state})
        await self._group_send({"type": P.S_ROOM, "room": state})

    # --- 受信 -----------------------------------------------------------------
    async def receive_json(self, content, **kwargs):
        if self.player_id is None or not isinstance(content, dict):
            return
        handler = {
            P.C_READY: self._on_ready,
            P.C_STATE: self._on_state,
            P.C_ATTACK: self._on_attack,
            P.C_TOPOUT: self._on_topout,
            P.C_PING: self._on_ping,
        }.get(content.get("type"))
        if handler is None:
            await self._send_error("unknown_type", f"不明なメッセージです: {content.get('type')}")
            return
        try:
            await handler(content)
        except DomainError as e:
            await self._send_error(e.code, str(e))

    async def _on_ready(self, msg: dict):
        room, started = await database_sync_to_async(services.set_ready)(self.player_id, bool(msg.get("ready", True)))
        await self._broadcast_room()
        if started:
            await self._group_send({
                "type": P.S_START, "seed": room.seed, "round": room.round, "countdown_ms": P.COUNTDOWN_MS,
            })

    async def _on_state(self, msg: dict):
        rows = msg.get("rows")
        if not isinstance(rows, list) or len(rows) > 40:
            return
        await self._group_send(
            {"type": P.S_OPPONENT_STATE, "slot": self.slot, "rows": rows, "stats": msg.get("stats", {}),
             "pending": msg.get("pending", 0)},
            exclude_self=True,
        )

    async def _on_attack(self, msg: dict):
        lines = msg.get("lines")
        if not isinstance(lines, int) or not 0 < lines <= P.MAX_ATTACK_PER_MESSAGE:
            return
        await self._group_send({"type": P.S_GARBAGE, "from_slot": self.slot, "lines": lines}, exclude_self=True)

    async def _on_topout(self, msg: dict):
        stats = msg.get("stats") if isinstance(msg.get("stats"), dict) else {}
        room, end = await database_sync_to_async(services.report_topout)(self.player_id, stats)
        if end is None:
            return
        state = await database_sync_to_async(selectors.room_state)(room)
        await self._group_send({"type": P.S_END, "winner_slot": end.winner_slot, "reason": end.reason, "room": state})

    async def _on_ping(self, msg: dict):
        await self.send_json({"type": P.S_PONG})

    # --- 送信 -----------------------------------------------------------------
    async def _broadcast_room(self):
        state = await _room_state_by_code(self.code)
        await self._group_send({"type": P.S_ROOM, "room": state})

    async def _group_send(self, payload: dict, exclude_self: bool = False):
        await self.channel_layer.group_send(
            self.group,
            {"type": "room.message", "payload": payload, "sender": self.channel_name if exclude_self else None},
        )

    async def room_message(self, event):
        """group_send で届いたメッセージをブラウザへ流す（type "room.message" の受け口）。"""
        if event.get("sender") and event["sender"] == self.channel_name:
            return
        await self.send_json(event["payload"])

    async def _send_error(self, code: str, message: str):
        await self.send_json({"type": P.S_ERROR, "code": code, "message": message})
