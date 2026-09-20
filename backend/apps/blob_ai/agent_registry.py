"""使える AI の一覧と、読み込み済み AI のキャッシュ（テトリスの apps/tetris_ai と同じ作り）。

AI の ID:
    "heuristic"          重み固定のヒューリスティック AI（学習なしで常に使える）
    "<run>:best"         runs/blob/<run>/checkpoints/best.pt
    "<run>:latest"       runs/blob/<run>/checkpoints/latest.pt
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from apps.common.errors import NotFound
from rl.blob.agent import Agent, HeuristicAgent, NeuralAgent

HEURISTIC_ID = "heuristic"
_CHECKPOINT_KINDS = ("best", "latest")


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str  # heuristic / best / latest
    path: Path | None
    updated_at: float | None  # ファイルの更新時刻（UNIX 秒）


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "blob"


def list_agents() -> list[AgentInfo]:
    """新しい学習の best が先頭。最後にヒューリスティック AI。"""
    found: list[AgentInfo] = []
    runs = _runs_dir()
    if runs.exists():
        for run_dir in runs.iterdir():
            for kind in _CHECKPOINT_KINDS:
                p = run_dir / "checkpoints" / f"{kind}.pt"
                if p.exists():
                    found.append(AgentInfo(f"{run_dir.name}:{kind}", f"{run_dir.name} ({kind})",
                                           run_dir.name, kind, p, p.stat().st_mtime))
    found.sort(key=lambda a: (a.kind != "best", -(a.updated_at or 0)))
    found.append(AgentInfo(HEURISTIC_ID, "ヒューリスティック（学習なし）", None, "heuristic", None, None))
    return found


def default_agent_id() -> str:
    return list_agents()[0].id


_cache: dict[str, tuple[float, Agent]] = {}
_lock = threading.Lock()


def get_agent(agent_id: str | None) -> Agent:
    """ID から AI を返す。チェックポイントが更新されていたら読み込み直す。"""
    agent_id = agent_id or default_agent_id()
    if agent_id == HEURISTIC_ID:
        return HeuristicAgent()
    info = next((a for a in list_agents() if a.id == agent_id), None)
    if info is None or info.path is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    with _lock:
        cached = _cache.get(agent_id)
        if cached and cached[0] == info.updated_at:
            return cached[1]
        agent = NeuralAgent.load(info.path, settings.BLOB_AI_DEVICE, lookahead=settings.BLOB_AI_LOOKAHEAD)
        agent.name = agent_id
        _cache[agent_id] = (info.updated_at or 0, agent)
        return agent
