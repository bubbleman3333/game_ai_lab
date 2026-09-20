"""カードを配って 1 局を進める部分と、スタックを持ち越す連戦（マッチ）。

ルールそのものは rules.py。ここは「デッキを混ぜる」「手番のプレイヤーに手を選ばせる」
「スタックが尽きたら退場」といった、局をまたぐ話を扱う。

`Match` は **AI が簡単に退場しないかを測るため**のもの。スタックを持ち越して
片方が 0 になるまで打ち、何局もったか・どちらが飛んだかを返す。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

from .cards import Rng, shuffled_deck
from .rules import (
    BIG_BLIND, DEFAULT_STACK, RAISE, RAISE_FRACTIONS, Action, State, action_from_index,
    advance_history, apply_action, legal_mask, new_hand, payoff,
)


def deal(rng: Rng, start_stack: int = DEFAULT_STACK, button: int = 0) -> State:
    """52 枚を混ぜて、ホールカード 2 枚ずつとボード 5 枚を配る。"""
    deck = shuffled_deck(rng)
    holes = ((deck[0], deck[2]), (deck[1], deck[3]))  # 1 枚ずつ交互に配る
    board = tuple(deck[4:9])
    return new_hand(holes, board, start_stack=start_stack, button=button)


class Policy(Protocol):
    """手を選ぶもの。打てる枠（legal_mask）の中から枠の番号を 1 つ返す。

    `hist` はここまでの行動の並び（`advance_history` が作る文字列）。
    CFR で学習した戦略は、この履歴と自分の手札で打ち方を決める。
    """

    def act(self, state: State, player: int, hist: str) -> int:
        ...


PolicyFn = Callable[[State, int, str], int]


@dataclass
class HandStep:
    """1 手の記録（学習データや画面の再生に使う）。"""

    player: int
    street: int
    index: int
    action: Action


@dataclass
class HandResult:
    final: State
    payoff: tuple[int, int]
    steps: list[HandStep] = field(default_factory=list)


def play_hand(
    state: State,
    policies: tuple[PolicyFn, PolicyFn],
    fractions: tuple[float, ...] = RAISE_FRACTIONS,
    max_raises: int | None = None,
) -> HandResult:
    """終局まで進める。`policies[p]` は枠の番号を返す関数。"""
    steps: list[HandStep] = []
    raises = 0
    street = state.street
    hist = ""
    while not state.finished:
        if state.street != street:
            street, raises = state.street, 0
        p = state.to_act
        mask = legal_mask(state, fractions, max_raises, raises)
        if not any(mask):
            raise RuntimeError("打てる手がないのに終局していない")
        index = policies[p](state, p, hist)
        if not (0 <= index < len(mask)) or not mask[index]:
            raise ValueError("打てない枠を選んだ: " + str(index))
        action = action_from_index(state, index, fractions)
        steps.append(HandStep(player=p, street=state.street, index=index, action=action))
        if action.kind == RAISE:
            raises += 1
        nxt = apply_action(state, action)
        hist = advance_history(state, nxt, index, hist)
        state = nxt
    return HandResult(final=state, payoff=payoff(state), steps=steps)


@dataclass
class MatchResult:
    """連戦の結果。`busted` が飛んだ側（-1 = 上限の局数まで誰も飛ばなかった）。"""

    hands: int
    stacks: tuple[int, int]
    busted: int
    chips: tuple[int, int]  # 収支の合計


def play_match(
    policies: tuple[PolicyFn, PolicyFn],
    seed: int,
    start_stack: int = DEFAULT_STACK,
    max_hands: int = 1000,
    fractions: tuple[float, ...] = RAISE_FRACTIONS,
    max_raises: int | None = None,
) -> MatchResult:
    """スタックを持ち越して、片方が飛ぶまで打つ。

    各局の有効スタックは「2 人のうち少ない方」。ブラインドすら払えなくなったら退場。
    """
    rng = Rng(seed)
    stacks = [start_stack, start_stack]
    total = [0, 0]
    for hand in range(max_hands):
        effective = min(stacks)
        if effective < BIG_BLIND * 2:
            return MatchResult(hand, (stacks[0], stacks[1]), 0 if stacks[0] <= stacks[1] else 1,
                               (total[0], total[1]))
        state = deal(rng, start_stack=effective, button=hand % 2)
        result = play_hand(state, policies, fractions, max_raises)
        for p in (0, 1):
            stacks[p] += result.payoff[p]
            total[p] += result.payoff[p]
    return MatchResult(max_hands, (stacks[0], stacks[1]), -1, (total[0], total[1]))
