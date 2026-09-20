"""ブロブチェイン AI の業務処理（Service 層）。view はここを呼ぶだけにする。"""

from __future__ import annotations

from apps.common.errors import DomainError
from rl.blob.position import Position

from . import agent_registry


def choose_move(position: dict, agent_id: str | None) -> dict:
    """局面から AI の手を返す。戻り値の形は serializers.MoveResponseSerializer。"""
    agent = agent_registry.get_agent(agent_id)
    pos = Position.from_dict(position)
    cand = agent.choose(pos)
    if cand is None:
        raise DomainError("置ける場所がありません（ゲームオーバーの局面です）", code="no_move", status=422)
    r = cand.result
    return {
        "agent": agent.name,
        "agent_episode": getattr(agent, "episode", None),
        "placement": {"x": cand.x, "rot": cand.rot},
        "path": cand.path,
        "expected": {
            "chain": r.chain, "score": r.score, "sent": r.sent, "cancelled": r.cancelled,
            "all_clear": r.all_clear, "dead": cand.dead,
        },
    }
