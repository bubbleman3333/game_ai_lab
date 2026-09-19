"""学習結果の読み取り（Repository の役割）。"""

from __future__ import annotations

from django.db.models import QuerySet

from apps.common.errors import NotFound

from .models import Evaluation, TrainingRun


def list_runs(game: str | None = None) -> QuerySet[TrainingRun]:
    qs = TrainingRun.objects.all()
    return qs.filter(game=game) if game else qs


def get_run(game: str, name: str) -> TrainingRun:
    run = TrainingRun.objects.filter(game=game, name=name).first()
    if run is None:
        raise NotFound(f"学習 {game}/{name} は見つかりません")
    return run


def list_evaluations(run: TrainingRun) -> QuerySet[Evaluation]:
    return run.evaluations.all()


def metric_buckets(run: TrainingRun, bucket: int) -> list[dict]:
    """エピソードを bucket 個ずつまとめる（グラフ用）。

    数値の項目は平均（avg）と最大（max）、真偽値の項目は割合（avg, 0〜1）にする。
    どの項目があるかはゲーム次第（metrics.jsonl の中身そのまま）。
    """
    out: list[dict] = []
    group: list[dict] = []

    def flush() -> None:
        sums: dict[str, float] = {}
        counts: dict[str, int] = {}
        maxes: dict[str, float] = {}
        for d in group:
            for k, v in d.items():
                if isinstance(v, bool):
                    v = 1.0 if v else 0.0
                elif not isinstance(v, (int, float)):
                    continue
                sums[k] = sums.get(k, 0.0) + v
                counts[k] = counts.get(k, 0) + 1
                maxes[k] = max(maxes.get(k, v), v)
        last = group[-1]
        out.append({
            "episode": last.get("episode", 0),
            "step": last.get("step", 0),
            "episodes": len(group),
            "avg": {k: sums[k] / counts[k] for k in sums},
            "max": maxes,
        })
        group.clear()

    for data in run.metrics.values_list("data", flat=True).iterator():
        group.append(data)
        if len(group) >= bucket:
            flush()
    if group:
        flush()
    return out
