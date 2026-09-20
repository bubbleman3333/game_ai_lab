"""レースの読み取り（Repository の役割）。"""

from django.db.models import Count, Min, Q

from .models import RaceResult


def summary() -> list[dict]:
    """コースと車ごとの、走った回数・ベストタイム・AI との勝ち負け。"""
    return list(
        RaceResult.objects.values("course", "car")
        .annotate(
            runs=Count("id"),
            best_lap=Min("best_lap_sec"),
            best_total=Min("total_sec"),
            wins=Count("id", filter=Q(place=1)),
            losses=Count("id", filter=Q(place__gt=1)),
        )
        .order_by("course", "car")
    )
