"""使える AI の一覧と、読み込み済み AI のキャッシュ。

AI の ID:
    "heuristic"          重み固定のヒューリスティック AI（学習なしで常に使える）
    "<run>:best"         runs/tetris/<run>/checkpoints/best.pt
    "<run>:latest"       runs/tetris/<run>/checkpoints/latest.pt
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

import torch

from apps.common.errors import NotFound
from rl.tetris.agent import Agent, HeuristicAgent, NeuralAgent

# 1 手ぶんの推論は小さい（候補手 数十 × 52 次元の MLP）ので、スレッドを増やすと
# 分割の手間のほうが大きくなる。実測でも 1 スレッドのほうが速い（学習と同時に動かすと差が開く）。
torch.set_num_threads(1)

HEURISTIC_ID = "heuristic"
_CHECKPOINT_KINDS = ("best", "latest")
# 既定の AI に選ぶための最低エピソード数。学習を始めたばかりの run は best.pt がいちばん新しくなるが、
# 中身はほぼランダムなので、これを下回る run は既定にしない（選べば使える）。
MIN_DEFAULT_EPISODES = 3000


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str  # heuristic / best / latest
    path: Path | None
    updated_at: float | None  # ファイルの更新時刻（UNIX 秒）


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "tetris"


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


def _run_episodes(run: str | None) -> int:
    """その学習が何エピソードまで進んでいるか（status.json。読めなければ 0）。"""
    if not run:
        return 0
    try:
        status = json.loads((_runs_dir() / run / "status.json").read_text(encoding="utf-8"))
        return int(status.get("episode", 0))
    except (OSError, ValueError, TypeError):
        return 0


def default_agent_id() -> str:
    """既定の AI。

    「いちばん新しい best」を選ぶと、学習を始めたばかりの run（ほぼランダム）を掴んでしまう。
    2 つ以上の学習を同時に回すと実際にそうなったので、ある程度進んだ run を優先する。
    """
    agents = list_agents()
    grown = [a for a in agents if a.kind == "best" and _run_episodes(a.run) >= MIN_DEFAULT_EPISODES]
    return (grown or agents)[0].id


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
        agent = NeuralAgent.load(info.path, settings.TETRIS_AI_DEVICE, lookahead=settings.TETRIS_AI_LOOKAHEAD)
        agent.name = agent_id
        _cache[agent_id] = (info.updated_at or 0, agent)
        return agent
