"""テトリス AI の業務処理（Service 層）。view はここを呼ぶだけにする。"""

from __future__ import annotations

from apps.common.errors import DomainError
from rl.tetris.position import Position

from . import agent_registry


def choose_move(position: dict, agent_id: str | None) -> dict:
    """局面から AI の手を返す。戻り値の形は serializers.MoveResponseSerializer。"""
    agent = agent_registry.get_agent(agent_id)
    pos = Position.from_dict(position)
    cand = agent.choose(pos)
    if cand is None:
        raise DomainError("置ける場所がありません（ゲームオーバーの局面です）", code="no_move", status=422)
    return {
        "agent": agent.name,
        "agent_episode": getattr(agent, "episode", None),
        "use_hold": cand.use_hold,
        "placement": cand.placement.to_dict(),
        "path": cand.path,
        "expected": {"lines": cand.outcome.lines, "attack": cand.outcome.attack, "dead": cand.dead},
    }
