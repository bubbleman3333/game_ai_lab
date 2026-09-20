"""学習結果の取り込み（Service 層）。runs/<ゲーム>/<学習名>/ の jsonl を DB に入れる。"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.db import transaction

from .models import Evaluation, Metric, TrainingRun


@dataclass
class SyncResult:
    game: str
    run: str
    new_metrics: int
    new_evaluations: int


def _read_new_lines(path: Path, offset: int) -> tuple[list[dict], int]:
    """offset バイト目から最後の完全な行までを読む。書きかけの最終行は次回に回す。

    学習中は行が増えるだけなので、前回の続きから読めばよい。ただし**ファイルが書き直される**
    ことがあり（`rl/<ゲーム>/evaluate.py --save-run` は evals.jsonl を毎回上書きする）、
    そのとき offset は行の途中を指してしまう。壊れた JSON になったら頭から読み直す。
    行は run + episode で上書き保存するので、読み直しても二重に入ることはない。
    """
    if not path.exists():
        return [], offset
    if offset > path.stat().st_size:
        offset = 0  # 短くなっている = 書き直された
    try:
        return _parse_from(path, offset)
    except json.JSONDecodeError:
        if offset == 0:
            raise
        return _parse_from(path, 0)


def _parse_from(path: Path, offset: int) -> tuple[list[dict], int]:
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n")
    if end < 0:
        return [], offset
    rows = [_clean(json.loads(line)) for line in data[: end + 1].splitlines() if line.strip()]
    return rows, offset + end + 1


def _clean(v):
    """DB の JSON に入らない値（NaN・Infinity）を None にする。"""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def _read_json(path: Path) -> dict:
    try:
        return _clean(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return {}


@transaction.atomic
def sync_run(game: str, run_dir: Path) -> SyncResult:
    run, created = TrainingRun.objects.get_or_create(game=game, name=run_dir.name)
    before = (run.config, run.status, run.metrics_offset, run.evals_offset)
    run.config = _read_json(run_dir / "config.json") or run.config
    run.status = _read_json(run_dir / "status.json") or run.status

    rows, run.metrics_offset = _read_new_lines(run_dir / "metrics.jsonl", run.metrics_offset)
    Metric.objects.bulk_create(
        [Metric(run=run, episode=r["episode"], data=r) for r in rows],
        update_conflicts=True, unique_fields=["run", "episode"], update_fields=["data"], batch_size=1000,
    )

    evals, run.evals_offset = _read_new_lines(run_dir / "evals.jsonl", run.evals_offset)
    Evaluation.objects.bulk_create(
        [
            Evaluation(
                run=run, episode=e["episode"], step=e.get("step", 0), checkpoint=e.get("checkpoint", ""),
                score=e.get("score") or 0, is_best=e.get("is_best", False), results=e.get("results", {}),
                evaluated_at=datetime.fromisoformat(e["at"]) if e.get("at") else None,
            )
            for e in evals
        ],
        update_conflicts=True, unique_fields=["run", "episode"],
        update_fields=["step", "checkpoint", "score", "is_best", "results", "evaluated_at"],
    )
    # **進みがあったときだけ保存する**。`synced_at` は auto_now なので、毎回保存すると
    # 「最後に同期した学習」が先頭に来てしまい、止まっている学習が上に並ぶ。
    # 動いている学習だけ時刻が進むようにすると、強さページの既定が今の学習になる。
    after = (run.config, run.status, run.metrics_offset, run.evals_offset)
    if created or after != before:
        run.save()
    return SyncResult(game, run.name, len(rows), len(evals))


def sync_all_runs(root: Path | None = None) -> list[SyncResult]:
    """root/<ゲーム>/<学習名>/config.json がある学習をすべて取り込む。"""
    root = Path(root or settings.TRAINING_RUNS_DIR)
    results: list[SyncResult] = []
    if not root.exists():
        return results
    for game_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for run_dir in sorted(p for p in game_dir.iterdir() if (p / "config.json").exists()):
            results.append(sync_run(game_dir.name, run_dir))
    return results
