"""将棋 AI（学習したネット）の一覧と読み込み。探索（MCTS）はサーバーの GPU で行う。

AI の ID:
    "<run>:best" / "<run>:latest"   runs/shogi/<run>/checkpoints/{best,latest}.pt
    "random"                        学習なし（ランダムに指す。画面の動作確認用）
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import torch
from django.conf import settings

from apps.common.errors import NotFound
from rl.shogi.mcts import MCTS
from rl.shogi.model import load

RANDOM_ID = "random"


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str
    path: Path | None
    updated_at: float | None


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "shogi"


def list_agents() -> list[AgentInfo]:
    found: list[AgentInfo] = []
    if _runs_dir().exists():
        for run_dir in _runs_dir().iterdir():
            for kind in ("best", "latest"):
                p = run_dir / "checkpoints" / f"{kind}.pt"
                if p.exists():
                    found.append(AgentInfo(f"{run_dir.name}:{kind}", f"{run_dir.name} ({kind})",
                                           run_dir.name, kind, p, p.stat().st_mtime))
    found.sort(key=lambda a: (a.kind != "best", -(a.updated_at or 0)))
    found.append(AgentInfo(RANDOM_ID, "学習なし（ランダム）", None, "random", None, None))
    return found


_cache: dict[str, tuple[float, MCTS, dict]] = {}
_load_lock = threading.Lock()
# GPU を使う探索は 1 つずつ行う（同時に来たら順番待ち）
search_lock = threading.Lock()


def get_searcher(agent_id: str) -> tuple[MCTS, dict]:
    info = next((a for a in list_agents() if a.id == agent_id and a.path), None)
    if info is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    with _load_lock:
        cached = _cache.get(agent_id)
        if cached and cached[0] == info.updated_at:
            return cached[1], cached[2]
        device = torch.device(settings.SHOGI_AI_DEVICE if torch.cuda.is_available() else "cpu")
        model, meta = load(info.path, device)
        searcher = MCTS(model, device)
        _cache[agent_id] = (info.updated_at or 0, searcher, meta)
        return searcher, meta
