"""部屋の読み取り（Repository の役割）。"""

from __future__ import annotations

from django.db.models import Count, QuerySet

from apps.common.errors import NotFound

from .models import Room, RoomPlayer


def get_room(code: str, game: str | None = None) -> Room:
    qs = Room.objects.filter(code=code.upper())
    room = (qs.filter(game=game) if game else qs).first()
    if room is None:
        raise NotFound(f"部屋 {code} は見つかりません")
    return room


def list_open_rooms(game: str = "tetris", limit: int = 50) -> QuerySet[Room]:
    """参加者が 1 人で相手を待っている部屋。"""
    return (
        Room.objects.filter(status=Room.Status.WAITING, game=game)
        .annotate(n=Count("players"))
        .filter(n=1)
        .prefetch_related("players")[:limit]
    )


def get_player(player_id: int) -> RoomPlayer | None:
    return RoomPlayer.objects.select_related("room").filter(id=player_id).first()


def room_state(room: Room) -> dict:
    """WebSocket と REST の両方で使う部屋の状態。"""
    return {
        "code": room.code,
        "status": room.status,
        "round": room.round,
        "players": [
            {"slot": p.slot, "name": p.name, "ready": p.ready, "alive": p.alive, "wins": p.wins}
            for p in room.players.all()
        ],
    }
