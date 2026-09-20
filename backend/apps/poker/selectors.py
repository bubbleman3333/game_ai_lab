"""読み取り（Repository 層）。"""

from __future__ import annotations

from django.db.models import Avg, Count, Sum

from games.poker.rules import BIG_BLIND
from .models import PokerHand, PokerTable


def recent_hands(limit: int = 30) -> list[dict]:
    rows = PokerHand.objects.all()[:limit]
    return [
        {
            "hand_no": h.hand_no,
            "agent": h.agent,
            "stack_bb": h.stack_bb,
            "human_payoff": h.human_payoff,
            "pot": h.pot,
            "showdown": h.showdown,
            "board": h.board,
            "human_hole": h.human_hole,
            "ai_hole": h.ai_hole if h.showdown else "",
            "created_at": h.created_at.isoformat(),
        }
        for h in rows
    ]


def agent_stats() -> list[dict]:
    """AI ごとの、人間相手の成績。

    mbb/hand は AI から見た値（プラスなら AI が勝っている）。ポーカーは運の幅が大きいので、
    数百局では符号すら当てにならない点に注意（`hands` も一緒に見る）。
    """
    rows = (
        PokerHand.objects.values("agent")
        .annotate(hands=Count("id"), human_chips=Sum("human_payoff"), avg_pot=Avg("pot"))
        .order_by("-hands")
    )
    out = []
    for r in rows:
        hands = r["hands"] or 0
        chips = r["human_chips"] or 0
        out.append({
            "agent": r["agent"],
            "hands": hands,
            "human_chips": chips,
            "ai_mbb_per_hand": round(-chips / hands / BIG_BLIND * 1000, 1) if hands else 0.0,
            "avg_pot": round(r["avg_pot"] or 0, 1),
        })
    return out


def table_count() -> int:
    return PokerTable.objects.count()
