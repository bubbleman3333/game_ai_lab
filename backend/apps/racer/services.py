"""レースの業務処理（Service 層）。"""

from apps.common.errors import DomainError
from apps.monitoring.models import Event
from apps.monitoring.services import record_event
from games.racer import course as CO
from games.racer import physics as P

from .models import RaceResult

MAX_SEC = 60 * 60


def save_result(course: str, car: str, agent: str, laps: int, total_sec: float,
                best_lap_sec: float, tricks: int = 0, falls: int = 0,
                place: int | None = None, racers: int = 1) -> RaceResult:
    if course not in CO.course_ids():
        raise DomainError(f"コース '{course}' はありません", code="unknown_course")
    if car not in P.car_ids():
        raise DomainError(f"車 '{car}' はありません", code="unknown_car")
    if not (0 < total_sec <= MAX_SEC) or not (0 < best_lap_sec <= MAX_SEC):
        raise DomainError("タイムがおかしいです", code="invalid_time")
    if best_lap_sec > total_sec + 1e-6:
        raise DomainError("ベストラップが総合タイムより長いです", code="invalid_time")
    if place is not None and place > racers:
        raise DomainError("順位が走者の数より大きいです", code="invalid_place")

    result = RaceResult.objects.create(
        course=course, car=car, agent=agent, laps=laps, total_sec=total_sec,
        best_lap_sec=best_lap_sec, tricks=tricks, falls=falls, place=place, racers=racers,
    )
    name = CO.load(course).name
    outcome = "" if place is None else f"・{place}/{racers} 位"
    record_event(Event.Kind.GAME,
                 f"レース: {name} を {total_sec:.1f} 秒（ベストラップ {best_lap_sec:.1f} 秒）{outcome}",
                 game="racer", data={"course": course, "car": car, "agent": agent})
    return result
