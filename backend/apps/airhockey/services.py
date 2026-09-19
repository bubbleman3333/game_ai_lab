"""エアホッケーの業務処理（Service 層）。"""

from apps.common.errors import DomainError

from .models import AirHockeyMatch
from apps.monitoring.models import Event
from apps.monitoring.services import record_event

MAX_SCORE = 99


def save_match(agent: str, level: str, human_score: int, ai_score: int, duration_sec: float) -> AirHockeyMatch:
    if not (0 <= human_score <= MAX_SCORE and 0 <= ai_score <= MAX_SCORE):
        raise DomainError("点数がおかしいです", code="invalid_score")
    match = AirHockeyMatch.objects.create(
        agent=agent, level=level, human_score=human_score, ai_score=ai_score, duration_sec=duration_sec,
    )
    outcome = "人の勝ち" if human_score > ai_score else "AI の勝ち"
    record_event(Event.Kind.GAME, f"エアホッケー: {outcome}（{human_score}-{ai_score}）", game="airhockey",
                 data={"agent": agent, "level": level})
    return match
