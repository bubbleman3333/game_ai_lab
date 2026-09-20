"""使えるレース AI の一覧と、方策（JSON）の読み込み。

AI の ID:
    "heuristic"      学習なしの運転者（ブラウザに組み込み済み。重みは配らない）
    "<run>:best"     runs/racer/<run>/checkpoints/best.json
    "<run>:latest"   runs/racer/<run>/checkpoints/latest.json

作りはエアホッケー（apps/airhockey/agent_registry.py）と同じ。
違うのは「学習なしより速いか」の判定だけで、レースでは評価に残した
「学習なしのタイム ÷ AI のタイム」（1 を超えたら AI のほうが速い）を見る。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from apps.common.errors import NotFound

HEURISTIC_ID = "heuristic"


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str
    path: Path | None
    updated_at: float | None


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "racer"


def list_agents() -> list[AgentInfo]:
    found: list[AgentInfo] = []
    if _runs_dir().exists():
        for run_dir in _runs_dir().iterdir():
            for kind in ("best", "latest"):
                p = run_dir / "checkpoints" / f"{kind}.json"
                if p.exists():
                    found.append(AgentInfo(f"{run_dir.name}:{kind}", f"{run_dir.name} ({kind})",
                                           run_dir.name, kind, p, p.stat().st_mtime))
    found.sort(key=lambda a: (a.kind != "best", -(a.updated_at or 0)))
    heuristic = AgentInfo(HEURISTIC_ID, "学習なし", None, "heuristic", None, None)
    # 学習した AI が学習なしより速くなるまでは、学習なしを既定（先頭）にする
    return found + [heuristic] if found and _beats_heuristic(found[0]) else [heuristic, *found]


def _beats_heuristic(info: AgentInfo) -> bool:
    """その学習の最新の評価で、学習なしの運転者より速く走れているか。"""
    if info.run is None:
        return False
    evals = _runs_dir() / info.run / "evals.jsonl"
    try:
        lines = evals.read_text(encoding="utf-8").strip().splitlines()
        best = [json.loads(l) for l in lines if json.loads(l).get("is_best")]
        return bool(best) and best[-1]["score"] > 1.0
    except (OSError, KeyError, ValueError):
        return False


def policy_json(agent_id: str) -> dict:
    info = next((a for a in list_agents() if a.id == agent_id and a.path), None)
    if info is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    return json.loads(info.path.read_text(encoding="utf-8"))
