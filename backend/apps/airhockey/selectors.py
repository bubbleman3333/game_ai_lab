"""エアホッケーの読み取り（Repository の役割）。"""

from django.db.models import Count, F, Q, Sum

from .models import AirHockeyMatch


def summary() -> list[dict]:
    """AI・速さごとの、人から見た勝ち負けと得点。"""
    return list(
        AirHockeyMatch.objects.values("agent", "level")
        .annotate(
            games=Count("id"),
            human_wins=Count("id", filter=Q(human_score__gt=F("ai_score"))),
            human_losses=Count("id", filter=Q(human_score__lt=F("ai_score"))),
            human_points=Sum("human_score"),
            ai_points=Sum("ai_score"),
        )
        .order_by("agent", "level")
    )
