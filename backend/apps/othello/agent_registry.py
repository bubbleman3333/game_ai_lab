"""使えるオセロ AI（評価関数）の一覧と、重みファイルの読み込み。

AI の ID:
    "positional"     マスの重み表（学習なし。ブラウザに組み込み済みなので重みの配信はない）
    "<run>:best"     runs/othello/<run>/checkpoints/best.npz
    "<run>:latest"   runs/othello/<run>/checkpoints/latest.npz
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from apps.common.errors import NotFound
from rl.othello.ntuple import NTupleNet

POSITIONAL_ID = "positional"
_KINDS = ("best", "latest")


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str  # positional / best / latest
    path: Path | None
    updated_at: float | None


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "othello"


def list_agents() -> list[AgentInfo]:
    found: list[AgentInfo] = []
    if _runs_dir().exists():
        for run_dir in _runs_dir().iterdir():
            for kind in _KINDS:
                p = run_dir / "checkpoints" / f"{kind}.npz"
                if p.exists():
                    found.append(AgentInfo(f"{run_dir.name}:{kind}", f"{run_dir.name} ({kind})",
                                           run_dir.name, kind, p, p.stat().st_mtime))
    found.sort(key=lambda a: (a.kind != "best", -(a.updated_at or 0)))
    found.append(AgentInfo(POSITIONAL_ID, "マスの重み表（学習なし）", None, "positional", None, None))
    return found


_cache: dict[str, tuple[float, bytes]] = {}
_lock = threading.Lock()


def weights_bytes(agent_id: str) -> bytes:
    """重み（Float32・リトルエンディアン、段階ごとに TABLE_SIZE 個ずつ）。ファイルが変わったら読み直す。"""
    info = next((a for a in list_agents() if a.id == agent_id and a.path), None)
    if info is None:
        raise NotFound(f"AI '{agent_id}' の重みは見つかりません")
    with _lock:
        cached = _cache.get(agent_id)
        if cached and cached[0] == info.updated_at:
            return cached[1]
        data = NTupleNet.load(info.path).w.astype("<f4").tobytes()
        _cache[agent_id] = (info.updated_at or 0, data)
        return data
