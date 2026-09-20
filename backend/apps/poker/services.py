"""テーブルを進める処理（Service 層）。

人の手はサーバー側の本物の状態にそのまま当てる（**ノーリミットなので額は自由**）。
一方 AI は「ポットの倍率で離散化した枠」しか知らないので、人が中途半端な額を賭けたときは
`rules.translate()` で一番近い枠に読み替えて**履歴の方だけ**を作る。
実際のポットは人が賭けたとおりで、AI に渡す履歴だけが近い枠に寄る
（これは実物のポーカー AI でも使われている「アクション変換」という考え方）。
"""

from __future__ import annotations

from django.core.exceptions import ValidationError
from django.db import transaction

from apps.common.errors import Conflict, DomainError, NotFound
from apps.monitoring.services import record_event
from games.poker.cards import Rng, cards_str, hand_value, value_name
from games.poker.game import deal
from games.poker.rules import (
    BIG_BLIND, CALL, CHECK, FOLD, RAISE, STREET_NAMES, Action, State, action_from_index,
    advance_history, apply_action, legal_mask, max_raise_to, min_raise_to, payoff,
    showdown_winner, to_call, translate,
)
from rl.poker import config as rl_config
from rl.poker.mccfr import street_raises
from . import agent_registry
from .models import PokerHand, PokerTable

HUMAN, AI = 0, 1
MIN_TABLE_STACK = BIG_BLIND * 2
MAX_START_STACK = 20_000
_KIND_BY_NAME = {"fold": FOLD, "check": CHECK, "call": CALL, "raise": RAISE}


# ---- 状態のしまい方（JSON ↔ State） ----


def state_to_json(st: State) -> dict:
    return {
        "holes": [list(st.holes[0]), list(st.holes[1])],
        "full_board": list(st.full_board),
        "street": st.street,
        "committed": list(st.committed),
        "street_bet": list(st.street_bet),
        "to_act": st.to_act,
        "acted": list(st.acted),
        "last_raise": st.last_raise,
        "folded": st.folded,
        "start_stack": st.start_stack,
        "button": st.button,
        "finished": st.finished,
    }


def state_from_json(d: dict) -> State:
    return State(
        holes=((d["holes"][0][0], d["holes"][0][1]), (d["holes"][1][0], d["holes"][1][1])),
        full_board=tuple(d["full_board"]),
        street=d["street"],
        committed=(d["committed"][0], d["committed"][1]),
        street_bet=(d["street_bet"][0], d["street_bet"][1]),
        to_act=d["to_act"],
        acted=(bool(d["acted"][0]), bool(d["acted"][1])),
        last_raise=d["last_raise"],
        folded=d["folded"],
        start_stack=d["start_stack"],
        button=d["button"],
        finished=bool(d["finished"]),
    )


# ---- テーブルを作る・局を配る ----


def create_table(agent_id: str | None, start_stack: int) -> PokerTable:
    if not MIN_TABLE_STACK * 5 <= start_stack <= MAX_START_STACK:
        raise DomainError(f"スタックは {MIN_TABLE_STACK * 5}〜{MAX_START_STACK} チップにしてください")
    agent_id = agent_id or agent_registry.default_agent_id()
    agent_registry.describe(agent_id)  # 無い AI ならここで 404
    table = PokerTable.objects.create(
        agent=agent_id,
        start_stack=start_stack,
        stacks=[start_stack, start_stack],
    )
    return deal_next_hand(table)


def deal_next_hand(table: PokerTable) -> PokerTable:
    """次の局を配る。前の局がまだ終わっていなければ拒否する。"""
    if table.state is not None and not state_from_json(table.state).finished:
        raise Conflict("まだ今の局が終わっていません")
    if min(table.stacks) < MIN_TABLE_STACK:
        raise Conflict("スタックが尽きました。新しいテーブルを作ってください")

    effective = min(table.stacks)
    table.hand_no += 1
    rng = Rng(abs(hash((str(table.id), table.hand_no))) & 0xFFFFFFFF)
    # 1 局目は人がボタン（＝先に行動する）。以降 1 局ごとに交代する
    st = deal(rng, start_stack=effective, button=(table.hand_no - 1) % 2)
    table.state = state_to_json(st)
    table.hist = ""
    table.log = []
    table.result = None
    with transaction.atomic():
        table.save()
    return _run_ai(table)


# ---- 手を打つ ----


def human_action(table: PokerTable, kind_name: str, to: int = 0) -> PokerTable:
    if table.state is None:
        raise Conflict("局が始まっていません")
    st = state_from_json(table.state)
    if st.finished:
        raise Conflict("この局はもう終わっています")
    if st.to_act != HUMAN:
        raise Conflict("いまは AI の手番です")
    kind = _KIND_BY_NAME.get(kind_name)
    if kind is None:
        raise DomainError(f"知らない手です: {kind_name}")

    need = to_call(st, HUMAN)
    if kind == FOLD and need == 0:
        raise DomainError("コールが要らない場面ではフォールドできません（チェックしてください）")
    if kind == CHECK and need != 0:
        raise DomainError("コールが要る場面ではチェックできません")
    if kind == CALL and need == 0:
        raise DomainError("コールが要らない場面です（チェックしてください）")

    if kind == RAISE:
        lo, hi = min_raise_to(st, HUMAN), max_raise_to(st, HUMAN)
        if st.stack_left(HUMAN) <= need or st.stack_left(AI) == 0:
            raise DomainError("この場面ではレイズできません")
        if not lo <= to <= hi:
            raise DomainError(f"レイズ額は {lo}〜{hi} にしてください")
        action_to = to
    else:
        action_to = st.street_bet[HUMAN] + (need if kind == CALL else 0)

    # AI に渡す履歴は「一番近い枠」に読み替える（AI は枠しか知らないため）
    index = translate(st, kind, action_to, rl_config.RAISE_FRACTIONS)
    action = Action(kind, to=action_to, index=index)
    nxt = apply_action(st, action)
    table.log = list(table.log) + [_log_line(st, HUMAN, kind, action_to, need)]
    table.hist = advance_history(st, nxt, index, table.hist)
    table.state = state_to_json(nxt)
    table.save()
    return _run_ai(table)


def _run_ai(table: PokerTable) -> PokerTable:
    """AI の手番が続くかぎり打たせる。終局したら後片付けをする。"""
    st = state_from_json(table.state)
    policy = agent_registry.get_policy(table.agent, seed=table.hand_no)
    log = list(table.log)
    hist = table.hist
    guard = 0
    while not st.finished and st.to_act == AI:
        guard += 1
        if guard > 40:
            raise DomainError("AI の手番が終わりません（不具合）")
        mask = legal_mask(st, rl_config.RAISE_FRACTIONS, rl_config.MAX_RAISES_PER_STREET,
                          street_raises(hist))
        index = policy(st, AI, hist)
        if not (0 <= index < len(mask)) or not mask[index]:
            index = next(i for i, ok in enumerate(mask) if ok)
        action = action_from_index(st, index, rl_config.RAISE_FRACTIONS)
        need = to_call(st, AI)
        log.append(_log_line(st, AI, action.kind, action.to, need))
        nxt = apply_action(st, action)
        hist = advance_history(st, nxt, index, hist)
        st = nxt
    table.log = log
    table.hist = hist
    table.state = state_to_json(st)
    if st.finished:
        _finish_hand(table, st)
    else:
        table.save()
    return table


def _log_line(st: State, player: int, kind: int, to: int, need: int) -> dict:
    who = "あなた" if player == HUMAN else "AI"
    if kind == FOLD:
        text = "フォールド"
    elif kind == CHECK:
        text = "チェック"
    elif kind == CALL:
        text = f"コール {need}"
    elif to >= st.street_bet[player] + st.stack_left(player):
        text = f"オールイン（{to}）"
    else:
        text = f"レイズ to {to}"
    return {"player": player, "street": st.street, "street_name": STREET_NAMES[st.street],
            "who": who, "text": f"{who}: {text}"}


def _finish_hand(table: PokerTable, st: State) -> None:
    """収支をスタックに反映し、記録を残す。"""
    gains = payoff(st)
    stacks = [table.stacks[0] + gains[0], table.stacks[1] + gains[1]]
    showdown = st.folded < 0
    winner = (1 - st.folded) if st.folded >= 0 else showdown_winner(st)
    table.stacks = stacks
    table.result = {
        "payoff": list(gains),
        "winner": winner,
        "folded": st.folded,  # 降りた席（-1 = 誰も降りていない）。画面で理由を出すため
        "showdown": showdown,
        "board": [int(c) for c in st.full_board],
        "ai_hole": [int(c) for c in st.holes[AI]],
        "human_hand": value_name(hand_value(tuple(st.holes[HUMAN]) + st.full_board)) if showdown else None,
        "ai_hand": value_name(hand_value(tuple(st.holes[AI]) + st.full_board)) if showdown else None,
        "busted": 0 if stacks[0] < MIN_TABLE_STACK else (1 if stacks[1] < MIN_TABLE_STACK else -1),
    }
    with transaction.atomic():
        table.save()
        PokerHand.objects.create(
            table=table,
            hand_no=table.hand_no,
            agent=table.agent,
            stack_bb=st.start_stack // BIG_BLIND,
            human_payoff=gains[HUMAN],
            pot=st.pot,
            showdown=showdown,
            board=cards_str(st.full_board) if showdown else cards_str(st.board),
            human_hole=cards_str(st.holes[HUMAN]),
            ai_hole=cards_str(st.holes[AI]),
        )
    if table.result["busted"] >= 0:
        who = "人" if table.result["busted"] == HUMAN else "AI"
        record_event("poker_bust", f"ポーカー: {who}が飛びました（{table.hand_no}局・AI={table.agent}）",
                     game="poker", data={"table": str(table.id), "agent": table.agent,
                                         "hands": table.hand_no, "busted": table.result["busted"]})


def get_table(table_id: str) -> PokerTable:
    try:
        return PokerTable.objects.get(id=table_id)
    except (PokerTable.DoesNotExist, ValidationError, ValueError, TypeError):
        raise NotFound("そのテーブルはありません")
