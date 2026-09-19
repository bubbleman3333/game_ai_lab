"""オセロの読み取り（Repository の役割）。"""

from __future__ import annotations

from django.db.models import Count, Q, QuerySet

from .models import OthelloGame


def recent_games(limit: int = 20) -> QuerySet[OthelloGame]:
    return OthelloGame.objects.all()[:limit]


def summary() -> list[dict]:
    """AI・強さごとの、人から見た勝ち・負け・引き分け。"""
    rows = (
        OthelloGame.objects.values("agent", "level")
        .annotate(
            games=Count("id"),
            human_wins=Count("id", filter=Q(human_result__gt=0)),
            human_losses=Count("id", filter=Q(human_result__lt=0)),
            draws=Count("id", filter=Q(human_result=0)),
        )
        .order_by("agent", "level")
    )
    return list(rows)
