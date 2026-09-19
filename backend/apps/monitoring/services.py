"""利用状況の記録（Service 層）。ほかのアプリからは record_event() だけを呼ぶ。

記録した出来事は DB に入れるだけでなく、logs/events.jsonl（日付ごとに切り替え、30 日で消える）にも
1 行 1 件の JSON で書く。Elasticsearch などにそのまま取り込める形。
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

from .models import Event, Presence

event_log = logging.getLogger("game_ai_lab.events")

ONLINE_SECONDS = 45  # この秒数以内に合図があれば「遊んでいる」とみなす
KEEP_DAYS = 30
GAMES = ("tetris", "blob", "othello", "airhockey", "shogi")


def game_of(path: str) -> str:
    part = path.strip("/").split("/")[0]
    return part if part in GAMES else ""


def heartbeat(session_id: str, path: str, device: str, nickname: str) -> None:
    Presence.objects.update_or_create(
        session_id=session_id,
        defaults={"path": path[:200], "game": game_of(path), "device": device, "nickname": nickname[:20],
                  "last_seen": timezone.now()},
    )


def leave(session_id: str) -> None:
    Presence.objects.filter(session_id=session_id).delete()


def record_event(kind: str, message: str, game: str = "", data: dict | None = None, session_id: str = "") -> None:
    """出来事を記録する。記録に失敗しても、ゲームの処理は止めない。"""
    try:
        Event.objects.create(kind=kind, game=game, message=message[:300], data=data or {}, session_id=session_id)
        event_log.info(message, extra={"event": {"kind": kind, "game": game, "data": data or {}}})
    except Exception:  # noqa: BLE001
        logging.getLogger(__name__).exception("record_event に失敗しました")


def cleanup() -> None:
    now = timezone.now()
    Presence.objects.filter(last_seen__lt=now - timedelta(hours=1)).delete()
    Event.objects.filter(created_at__lt=now - timedelta(days=KEEP_DAYS)).delete()
