"""対戦の業務処理（Service 層）。consumer（WebSocket）と view（REST）の両方から呼ぶ。

ここは同期関数。consumer からは database_sync_to_async 経由で呼ぶ。
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from apps.common.errors import Conflict, NotFound

from . import selectors
from .models import MatchResult, Room, RoomPlayer
from .protocol import MAX_NAME_LENGTH
from apps.monitoring.models import Event
from apps.monitoring.services import record_event

_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 見間違えやすい 0/O/1/I は使わない


def create_room(game: str = "tetris") -> Room:
    for _ in range(10):
        code = "".join(secrets.choice(_CODE_CHARS) for _ in range(5))
        if not Room.objects.filter(code=code).exists():
            return Room.objects.create(code=code, game=game)
    raise Conflict("部屋コードを作れませんでした。もう一度試してください")


def clean_name(name: str) -> str:
    name = (name or "").strip()[:MAX_NAME_LENGTH]
    return name or "ゲスト"


@transaction.atomic
def join_room(code: str, name: str, channel_name: str, game: str = "tetris") -> RoomPlayer:
    room = Room.objects.select_for_update().filter(code=code.upper(), game=game).first()
    if room is None:
        raise NotFound(f"部屋 {code} は見つかりません")
    used = set(room.players.values_list("slot", flat=True))
    free = [s for s in (0, 1) if s not in used]
    if not free:
        raise Conflict("この部屋は満員です", code="room_full")
    return RoomPlayer.objects.create(room=room, slot=free[0], name=clean_name(name), channel_name=channel_name)


@dataclass
class EndOfRound:
    winner_slot: int
    reason: str


@transaction.atomic
def leave_room(player_id: int) -> tuple[Room | None, EndOfRound | None]:
    """切断時の処理。対戦中なら残った側の勝ち。誰もいなくなったら部屋を消す。"""
    player = selectors.get_player(player_id)
    if player is None:
        return None, None
    room = player.room
    end = None
    if room.status == Room.Status.PLAYING:
        other = room.players.exclude(id=player.id).first()
        if other is not None:
            end = _finish_round(room, winner=other, loser=player, reason=MatchResult.Reason.DISCONNECT, stats={})
    player.delete()
    if not room.players.exists():
        room.delete()
        return None, end
    room.status = Room.Status.WAITING
    room.save(update_fields=["status"])
    room.players.update(ready=False, alive=True)
    return room, end


@transaction.atomic
def set_ready(player_id: int, ready: bool) -> tuple[Room, bool]:
    """戻り値: (部屋, 対戦を開始したか)。2 人とも ready なら開始する。"""
    player = selectors.get_player(player_id)
    if player is None:
        raise NotFound("参加者が見つかりません")
    room = Room.objects.select_for_update().get(id=player.room_id)
    if room.status == Room.Status.PLAYING:
        return room, False
    player.ready = ready
    player.save(update_fields=["ready"])
    players = list(room.players.all())
    if len(players) == 2 and all(p.ready for p in players):
        room.status = Room.Status.PLAYING
        room.seed = secrets.randbits(31)
        room.round += 1
        room.started_at = timezone.now()
        room.save()
        room.players.update(ready=False, alive=True)
        return room, True
    return room, False


@transaction.atomic
def report_topout(player_id: int, stats: dict) -> tuple[Room, EndOfRound | None]:
    player = selectors.get_player(player_id)
    if player is None:
        raise NotFound("参加者が見つかりません")
    room = Room.objects.select_for_update().get(id=player.room_id)
    if room.status != Room.Status.PLAYING or not player.alive:
        return room, None
    other = room.players.exclude(id=player.id).first()
    if other is None:
        return room, None
    end = _finish_round(room, winner=other, loser=player, reason=MatchResult.Reason.TOPOUT,
                        stats={str(player.slot): stats})
    return room, end


def _finish_round(room: Room, winner: RoomPlayer, loser: RoomPlayer, reason: str, stats: dict) -> EndOfRound:
    duration = (timezone.now() - room.started_at).total_seconds() if room.started_at else 0
    MatchResult.objects.create(
        room=room, round=room.round, winner_name=winner.name, loser_name=loser.name,
        winner_slot=winner.slot, reason=reason, duration_sec=duration, stats=stats,
    )
    loser.alive = False
    loser.save(update_fields=["alive"])
    winner.wins += 1
    winner.save(update_fields=["wins"])
    room.status = Room.Status.WAITING
    room.save(update_fields=["status"])
    title = {"tetris": "テトリス", "blob": "ブロブチェイン"}.get(room.game, room.game)
    record_event(Event.Kind.GAME, f"{title}対戦: {winner.name} が {loser.name} に勝ち（{reason}）", game=room.game,
                 data={"room": room.code, "round": room.round})
    return EndOfRound(winner.slot, reason)
