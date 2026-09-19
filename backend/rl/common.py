"""学習の共通部分。学習結果は runs/<ゲーム名>/<学習名>/ に置く（apps/training が取り込む）。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

RUNS_ROOT = Path(__file__).resolve().parents[1] / "runs"


def runs_dir(game: str) -> Path:
    return RUNS_ROOT / game


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def append_jsonl(path: Path, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
