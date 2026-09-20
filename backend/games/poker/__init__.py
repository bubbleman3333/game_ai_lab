"""ヘッズアップ・ノーリミット テキサスホールデムのルールエンジン（純粋な Python）。

TypeScript 版は frontend/src/games/poker/engine/。ルールを変えたら両方直し、
python -m games.poker.fixtures でテストデータを作り直すこと。
"""

from .cards import (
    CATEGORY_NAMES, DECK, NUM_CARDS, RANK_CHARS, SUIT_CHARS, Rng,
    card_str, cards_str, category_of, compare, hand_value, make_card,
    parse_card, parse_cards, rank_of, shuffled_deck, suit_of, value_name,
)
from .game import HandResult, HandStep, MatchResult, deal, play_hand, play_match
from .rules import (
    ACTION_COUNT, BIG_BLIND, BOARD_COUNT, CALL, CHECK, DEFAULT_STACK, FOLD,
    IDX_ALL_IN, IDX_CHECK_CALL, IDX_FOLD, IDX_RAISE_BASE, PREFLOP, FLOP, TURN, RIVER,
    RAISE, RAISE_FRACTIONS, SMALL_BLIND, STREET_NAMES, Action, State,
    action_count, action_from_index, apply_action, can_raise, describe, legal_actions,
    legal_mask, max_raise_to, min_raise_to, new_hand, payoff, raise_to_for_fraction,
    showdown_winner, to_call, translate,
)

__all__ = [
    "CATEGORY_NAMES", "DECK", "NUM_CARDS", "RANK_CHARS", "SUIT_CHARS", "Rng",
    "card_str", "cards_str", "category_of", "compare", "hand_value", "make_card",
    "parse_card", "parse_cards", "rank_of", "shuffled_deck", "suit_of", "value_name",
    "HandResult", "HandStep", "MatchResult", "deal", "play_hand", "play_match",
    "ACTION_COUNT", "BIG_BLIND", "BOARD_COUNT", "CALL", "CHECK", "DEFAULT_STACK", "FOLD",
    "IDX_ALL_IN", "IDX_CHECK_CALL", "IDX_FOLD", "IDX_RAISE_BASE",
    "PREFLOP", "FLOP", "TURN", "RIVER",
    "RAISE", "RAISE_FRACTIONS", "SMALL_BLIND", "STREET_NAMES", "Action", "State",
    "action_count", "action_from_index", "apply_action", "can_raise", "describe",
    "legal_actions", "legal_mask", "max_raise_to", "min_raise_to", "new_hand", "payoff",
    "raise_to_for_fraction", "showdown_winner", "to_call", "translate",
]
