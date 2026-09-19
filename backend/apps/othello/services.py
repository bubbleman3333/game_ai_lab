"""オセロの業務処理（Service 層）。"""

from __future__ import annotations

from apps.common.errors import DomainError
from games.othello.board import play_moves, popcount

from .models import OthelloGame
from apps.monitoring.models import Event
from apps.monitoring.services import record_event


def save_game(moves: str, human_color: str, agent: str, level: str) -> OthelloGame:
    """棋譜をサーバー側のエンジンで最初から再生して確かめ、終局していれば保存する。"""
    try:
        pos = play_moves(moves)
    except (ValueError, IndexError) as e:
        raise DomainError(f"棋譜が正しくありません: {e}", code="invalid_moves") from e
    if not pos.is_over():
        raise DomainError("まだ終局していません", code="not_finished")
    black, white = popcount(pos.black), popcount(pos.white)
    score = pos.final_score()
    black_result = score if pos.black_to_move else -score
    human_result = black_result if human_color == OthelloGame.Color.BLACK else -black_result
    game = OthelloGame.objects.create(
        moves=moves, human_color=human_color, agent=agent, level=level,
        black_discs=black, white_discs=white, human_result=human_result,
    )
    outcome = "人の勝ち" if human_result > 0 else "AI の勝ち" if human_result < 0 else "引き分け"
    record_event(Event.Kind.GAME, f"オセロ: {outcome}（{black}-{white}）", game="othello",
                 data={"agent": agent, "level": level, "human_result": human_result})
    return game
