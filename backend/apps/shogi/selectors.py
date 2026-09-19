"""将棋の読み取り（Repository の役割）。"""

from __future__ import annotations

import cshogi
from django.db.models import Count, Q

from apps.common.errors import NotFound

from . import services
from .models import ShogiGame


def get_game(game_id: int) -> ShogiGame:
    game = ShogiGame.objects.filter(id=game_id).first()
    if game is None:
        raise NotFound("対局が見つかりません")
    return game


def game_state(game: ShogiGame) -> dict:
    """画面に渡す対局の状態。盤面は SFEN、指せる手は USI の一覧。"""
    board = services.board_of(game)
    your_turn = not game.result and services.human_turn(game, board)
    moves = game.move_list
    return {
        "id": game.id,
        "human_color": game.human_color,
        "agent": game.agent,
        "level": game.level,
        "sfen": board.sfen(),
        "turn": "black" if board.turn == cshogi.BLACK else "white",
        "in_check": board.is_check(),
        "your_turn": your_turn,
        "legal_moves": [cshogi.move_to_usi(m) for m in board.legal_moves] if your_turn else [],
        "can_declare": bool(your_turn and board.is_nyugyoku()),
        "moves": moves,
        "kif": services.kif_moves(game),
        "last_move": moves[-1] if moves else None,
        "result": game.result or None,
        "reason": game.reason or None,
        "ai": game.last_ai or None,
    }


def summary() -> list[dict]:
    rows = (
        ShogiGame.objects.exclude(result="")
        .values("agent", "level")
        .annotate(
            games=Count("id"),
            human_wins=Count("id", filter=Q(result=ShogiGame.Result.HUMAN_WIN)),
            human_losses=Count("id", filter=Q(result=ShogiGame.Result.AI_WIN)),
            draws=Count("id", filter=Q(result=ShogiGame.Result.DRAW)),
        )
        .order_by("agent", "level")
    )
    return list(rows)
