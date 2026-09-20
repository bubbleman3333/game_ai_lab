"""使える AI の一覧と、読み込み済み戦略のキャッシュ（apps/blob_ai と同じ作り）。

AI の ID:
    "heuristic"      学習なしのルールベース（いつでも使える）
    "<run>:best"     runs/poker/<run>/checkpoints/best.npz
    "<run>:latest"   runs/poker/<run>/checkpoints/latest.npz

学習した戦略は「まだ学習していない場面」では打ち方を持たない。そこはルールベースに任せる
（`rl.poker.players.strategy_player` の `fallback`）。学習の途中でも、でたらめを打たない。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from apps.common.errors import NotFound
from rl.poker import players
from rl.poker.mccfr import Strategy

HEURISTIC_ID = "heuristic"
_CHECKPOINT_KINDS = ("best", "latest")


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str  # heuristic / best / latest
    path: Path | None
    updated_at: float | None
    infosets: int | None = None


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "poker"


def list_agents() -> list[AgentInfo]:
    """新しい学習の best が先頭。最後にルールベース。"""
    found: list[AgentInfo] = []
    runs = _runs_dir()
    if runs.exists():
        for run_dir in sorted(runs.iterdir()):
            if not run_dir.is_dir():
                continue
            for kind in _CHECKPOINT_KINDS:
                p = run_dir / "checkpoints" / f"{kind}.npz"
                if p.exists():
                    found.append(AgentInfo(f"{run_dir.name}:{kind}", f"{run_dir.name}（{kind}）",
                                           run_dir.name, kind, p, p.stat().st_mtime))
    found.sort(key=lambda a: (a.kind != "best", -(a.updated_at or 0)))
    found.append(AgentInfo(HEURISTIC_ID, "ルールベース（学習なし）", None, "heuristic", None, None))
    return found


def default_agent_id() -> str:
    return list_agents()[0].id


_cache: dict[str, tuple[float, Strategy]] = {}
_lock = threading.Lock()


def _strategy(info: AgentInfo) -> Strategy:
    with _lock:
        cached = _cache.get(info.id)
        if cached and cached[0] == info.updated_at:
            return cached[1]
        strategy = Strategy.from_file(info.path)
        _cache[info.id] = (info.updated_at or 0.0, strategy)
        return strategy


def get_policy(agent_id: str | None, seed: int = 0):
    """ID から「手を選ぶ関数」を返す。"""
    agent_id = agent_id or default_agent_id()
    if agent_id == HEURISTIC_ID:
        return players.heuristic(seed)
    info = next((a for a in list_agents() if a.id == agent_id), None)
    if info is None or info.path is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    return players.strategy_player(_strategy(info), seed=seed, fallback=players.heuristic(seed + 1))


def describe(agent_id: str) -> AgentInfo:
    info = next((a for a in list_agents() if a.id == agent_id), None)
    if info is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    if info.path is None:
        return info
    strategy = _strategy(info)
    return AgentInfo(info.id, info.label, info.run, info.kind, info.path, info.updated_at,
                     infosets=len(strategy))
