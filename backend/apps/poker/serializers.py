"""入出力の形（DTO）。

`table_view()` が**ブラウザに返してよいもの**を組み立てる。ここで AI の手札を落とすのが
このゲームの一番大事なところ。ショーダウンまで進んだときだけ AI の手札を入れる。
"""

from __future__ import annotations

from rest_framework import serializers

from games.poker.cards import card_str
from games.poker.rules import (
    BIG_BLIND, SMALL_BLIND, STREET_NAMES, max_raise_to, min_raise_to, raise_to_for_fraction,
    to_call,
)
from rl.poker import config as rl_config
from .services import AI, HUMAN, state_from_json


class TableCreateSerializer(serializers.Serializer):
    agent = serializers.CharField(required=False, allow_blank=True, max_length=100)
    stack = serializers.IntegerField(required=False, min_value=20, max_value=20_000, default=200)


class ActionSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["fold", "check", "call", "raise"])
    to = serializers.IntegerField(required=False, min_value=0, max_value=100_000, default=0)


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()
    family = serializers.CharField()  # neural / table / heuristic
    detail = serializers.CharField(allow_blank=True)


def _cards(values) -> list[str]:
    return [card_str(int(c)) for c in values]


def table_view(table) -> dict:
    """ブラウザに返す 1 つのまとまり。**AI の手札はショーダウンまで入れない**。"""
    st = state_from_json(table.state)
    result = table.result
    showdown = bool(result and result["showdown"])
    # 降りて終わった局では、これ以上ボードをめくらない（AI の手札も見せない）
    board = st.full_board if showdown else st.board
    need = to_call(st, HUMAN) if not st.finished else 0
    can_raise = (
        not st.finished
        and st.to_act == HUMAN
        and st.stack_left(HUMAN) > need
        and st.stack_left(AI) > 0
    )
    last_actions = _last_actions(table.log, st.street, st.finished)
    view = {
        "table_id": str(table.id),
        "agent": table.agent,
        "hand_no": table.hand_no,
        "button": st.button,
        "you": HUMAN,
        "ai": AI,
        "blinds": [SMALL_BLIND, BIG_BLIND],
        "street": st.street,
        "street_name": STREET_NAMES[st.street],
        "board": _cards(board),
        "your_hole": _cards(st.holes[HUMAN]),
        "ai_hole": _cards(result["ai_hole"]) if showdown else None,
        "pot": st.pot,
        "committed": list(st.committed),
        "street_bet": list(st.street_bet),
        "hand_stacks": [st.stack_left(0), st.stack_left(1)],
        "table_stacks": list(table.stacks),
        "start_stack": table.start_stack,
        "to_act": None if st.finished else st.to_act,
        "to_call": need,
        "finished": st.finished,
        "log": list(table.log),
        "last_actions": last_actions,
        "result": None,
        "actions": {
            "can_fold": not st.finished and st.to_act == HUMAN and need > 0,
            "can_check": not st.finished and st.to_act == HUMAN and need == 0,
            "can_call": not st.finished and st.to_act == HUMAN and need > 0,
            "call_amount": need,
            "can_raise": can_raise,
            "min_raise_to": min_raise_to(st, HUMAN) if can_raise else 0,
            "max_raise_to": max_raise_to(st, HUMAN) if can_raise else 0,
            "presets": _presets(st) if can_raise else [],
        },
    }
    if result:
        view["result"] = {
            "payoff": result["payoff"],
            "winner": result["winner"],
            "folded": result.get("folded", -1),
            "showdown": result["showdown"],
            "human_hand": result.get("human_hand"),
            "ai_hand": result.get("ai_hand"),
            "busted": result.get("busted", -1),
        }
    return view


def _last_actions(log: list, street: int, finished: bool) -> list[str | None]:
    """席ごとの「直前にした行動」。画面の吹き出しに出す。

    途中の局では**今のストリートの行動だけ**を見せる（前のストリートの行動が残っていると
    「いま何をされたのか」が分からなくなる）。終わった局では、ストリートに関係なく
    最後の行動を見せる（オールインのあとリバーまで一気に進むので、ストリートがずれるため）。
    """
    out: list[str | None] = [None, None]
    for line in log:
        player = line.get("player")
        if player not in (0, 1):
            continue
        if finished or line.get("street") == street:
            out[player] = line["text"].split(": ", 1)[-1]
    return out


def _presets(st) -> list[dict]:
    """ワンタッチで押せるレイズ額（AI が学習している枠と同じ倍率 + オールイン）。"""
    out: list[dict] = []
    seen: set[int] = set()
    for frac in rl_config.RAISE_FRACTIONS:
        amount = raise_to_for_fraction(st, frac)
        if amount in seen:
            continue
        seen.add(amount)
        out.append({"label": f"ポットの{frac:g}倍", "to": amount})
    all_in = max_raise_to(st, HUMAN)
    if all_in not in seen:
        out.append({"label": "オールイン", "to": all_in})
    return out
