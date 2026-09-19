"""利用状況の読み取り（Repository の役割）。"""

from __future__ import annotations

from datetime import timedelta

from django.db.models import Count
from django.utils import timezone

from .models import Event, Presence
from .services import ONLINE_SECONDS


def live() -> dict:
    now = timezone.now()
    online = list(Presence.objects.filter(last_seen__gte=now - timedelta(seconds=ONLINE_SECONDS))
                  .order_by("-last_seen"))
    today = timezone.localtime(now).replace(hour=0, minute=0, second=0, microsecond=0)
    by_game: dict[str, dict] = {}
    for p in online:
        g = by_game.setdefault(p.game or "top", {"game": p.game or "top", "players": 0, "mobile": 0})
        g["players"] += 1
        g["mobile"] += p.device == "mobile"
    games_today = (Event.objects.filter(created_at__gte=today, kind=Event.Kind.GAME)
                   .values("game").annotate(n=Count("id")))
    return {
        "now": now.isoformat(),
        "online": len(online),
        "by_game": sorted(by_game.values(), key=lambda g: -g["players"]),
        "sessions": [
            {"nickname": p.nickname, "path": p.path, "game": p.game, "device": p.device,
             "since": p.first_seen.isoformat(), "last_seen": p.last_seen.isoformat()}
            for p in online
        ],
        "today": {
            "visitors": Presence.objects.filter(first_seen__gte=today).count(),
            "games": {row["game"] or "other": row["n"] for row in games_today},
            "errors": Event.objects.filter(created_at__gte=today).exclude(kind=Event.Kind.GAME).count(),
        },
        "events": [
            {"at": e.created_at.isoformat(), "kind": e.kind, "game": e.game, "message": e.message, "data": e.data}
            for e in Event.objects.all()[:50]
        ],
    }
