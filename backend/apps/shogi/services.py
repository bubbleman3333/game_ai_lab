"""将棋の対局の業務処理（Service 層）。ルールの判定はすべてサーバー側（cshogi）で行う。"""

from __future__ import annotations

import random

import cshogi
from cshogi import KIF
from django.db import transaction

from apps.common.errors import Conflict, DomainError, NotFound

from . import agent_registry
from .models import ShogiGame
from apps.monitoring.models import Event
from apps.monitoring.services import record_event

MAX_PLY = 512
SENNICHITE_COUNT = 4  # 同じ局面が 4 回現れたら千日手

# 強さ: 読む回数（プレイアウト数）と時間の上限（秒）。policy_only は探索せずネットの第一感で指す
LEVELS: dict[str, dict] = {
    "beginner": {"label": "入門（読まずに第一感で指す）", "playouts": 1, "time": 0},
    "easy": {"label": "初級（50 回読む）", "playouts": 50, "time": 0},
    "normal": {"label": "中級（300 回読む）", "playouts": 300, "time": 0},
    "hard": {"label": "上級（1500 回読む）", "playouts": 1500, "time": 0},
    "max": {"label": "最強（5 秒で読めるだけ）", "playouts": 100000, "time": 5.0},
}


def _notify_end(game: ShogiGame) -> None:
    """終局したら利用状況の出来事に記録する。"""
    if game.result:
        label = {"human_win": "人の勝ち", "ai_win": "AI の勝ち", "draw": "引き分け"}[game.result]
        record_event(Event.Kind.GAME, f"将棋: {label}（{game.reason}・{len(game.move_list)} 手）", game="shogi",
                     data={"agent": game.agent, "level": game.level, "human_color": game.human_color})


def board_of(game: ShogiGame) -> cshogi.Board:
    b = cshogi.Board()
    for u in game.move_list:
        b.push_usi(u)
    return b


def repetition_count(game: ShogiGame) -> int:
    """今の局面（盤・持ち駒・手番）が対局中に何回現れたか（今の局面を含む）。"""
    b = cshogi.Board()
    hashes = [b.zobrist_hash()]
    for u in game.move_list:
        b.push_usi(u)
        hashes.append(b.zobrist_hash())
    return hashes.count(hashes[-1])


def human_turn(game: ShogiGame, board: cshogi.Board) -> bool:
    return (board.turn == cshogi.BLACK) == (game.human_color == ShogiGame.Color.BLACK)


def _judge(game: ShogiGame, board: cshogi.Board) -> None:
    """直前の手で終局したか調べ、終局なら結果を書き込む（保存はしない）。"""
    human_to_move = human_turn(game, board)

    def lose_side_to_move(reason: str) -> None:
        game.result = ShogiGame.Result.AI_WIN if human_to_move else ShogiGame.Result.HUMAN_WIN
        game.reason = reason

    # cshogi の is_draw は 1 回の繰り返しで反応するので、本当の千日手（4 回目）のときだけ使う
    rep = board.is_draw(MAX_PLY) if repetition_count(game) >= SENNICHITE_COUNT else cshogi.NOT_REPETITION
    if rep == cshogi.REPETITION_DRAW:
        game.result, game.reason = ShogiGame.Result.DRAW, "千日手"
    elif rep == cshogi.REPETITION_LOSE:  # 手番側が連続王手の千日手をかけていた
        lose_side_to_move("連続王手の千日手")
    elif rep == cshogi.REPETITION_WIN:
        game.result = ShogiGame.Result.HUMAN_WIN if human_to_move else ShogiGame.Result.AI_WIN
        game.reason = "連続王手の千日手"
    elif board.is_game_over():
        lose_side_to_move("詰み")
    elif board.move_number > MAX_PLY:
        game.result, game.reason = ShogiGame.Result.DRAW, "手数上限"


def _think(game: ShogiGame, board: cshogi.Board) -> dict:
    """AI の手を考える（DB は触らない。最強だと数秒かかる）。戻り値は last_ai に入れる情報。"""
    if board.is_nyugyoku():
        return {"declare": True}
    if game.agent == agent_registry.RANDOM_ID:
        return {"move": cshogi.move_to_usi(random.choice(list(board.legal_moves)))}
    searcher, meta = agent_registry.get_searcher(game.agent)
    lv = LEVELS.get(game.level, LEVELS["normal"])
    with agent_registry.search_lock:
        r = searcher.search(board, playouts=lv["playouts"], time_limit=lv["time"])
    return {
        "move": r.move, "winrate": r.winrate, "playouts": r.playouts, "time_ms": r.time_ms,
        "pv": r.pv, "candidates": r.candidates, "trained_steps": meta.get("step"),
    }


def _ai_reply(game_id: int) -> ShogiGame:
    """AI の番なら考えて指す。探索は DB のトランザクションの外で行い、保存するときだけ短くロックする
    （探索中に DB をつかんだままにすると、ほかの保存が待たされて失敗するため）。"""
    game = ShogiGame.objects.get(id=game_id)
    board = board_of(game)
    if game.result or human_turn(game, board):
        return game
    before = game.moves
    info = _think(game, board)
    with transaction.atomic():
        game = ShogiGame.objects.select_for_update().get(id=game_id)
        if game.moves != before or game.result:
            return game  # 考えている間に待った・投了などで局面が変わった
        if info.get("declare"):
            game.result, game.reason = ShogiGame.Result.AI_WIN, "入玉宣言"
        else:
            board = board_of(game)
            board.push_usi(info["move"])
            game.moves = " ".join([*game.move_list, info["move"]])
            game.last_ai = info
            _judge(game, board)
        game.save()
    _notify_end(game)
    return game


def start_game(human_color: str, agent: str, level: str) -> ShogiGame:
    if level not in LEVELS:
        raise DomainError(f"強さ '{level}' はありません", code="invalid_level")
    if agent != agent_registry.RANDOM_ID and not any(a.id == agent for a in agent_registry.list_agents()):
        raise NotFound(f"AI '{agent}' は見つかりません")
    game = ShogiGame.objects.create(human_color=human_color, agent=agent, level=level)
    record_event(Event.Kind.GAME, f"将棋: 対局開始（{'先手' if human_color == 'black' else '後手'}・{level}）",
                 game="shogi", data={"agent": agent, "level": level})
    return _ai_reply(game.id)  # 人が後手なら AI が初手を指す


def _get_open(game_id: int) -> ShogiGame:
    game = ShogiGame.objects.select_for_update().filter(id=game_id).first()
    if game is None:
        raise NotFound("対局が見つかりません")
    if game.result:
        raise Conflict("この対局は終わっています", code="finished")
    return game


def play(game_id: int, usi: str) -> ShogiGame:
    """人の手を指して保存し、終局していなければ AI が応じる。"""
    with transaction.atomic():
        game = _get_open(game_id)
        board = board_of(game)
        if not human_turn(game, board):
            raise Conflict("AI の手番です", code="not_your_turn")
        try:
            move = board.move_from_usi(usi)
        except Exception as e:
            raise DomainError(f"指し手の形式が正しくありません: {usi}", code="invalid_move") from e
        if not move or not board.is_legal(move):
            raise DomainError(f"{usi} は指せません", code="illegal_move")
        board.push(move)
        game.moves = " ".join([*game.move_list, usi])
        _judge(game, board)
        game.save()
    if game.result:
        _notify_end(game)
        return game
    return _ai_reply(game_id)


@transaction.atomic
def resign(game_id: int) -> ShogiGame:
    game = _get_open(game_id)
    game.result, game.reason = ShogiGame.Result.AI_WIN, "投了"
    game.save()
    _notify_end(game)
    return game


@transaction.atomic
def declare(game_id: int) -> ShogiGame:
    """人の入玉宣言。条件を満たしていれば勝ち。"""
    game = _get_open(game_id)
    board = board_of(game)
    if not human_turn(game, board) or not board.is_nyugyoku():
        raise DomainError("入玉宣言の条件を満たしていません", code="cannot_declare")
    game.result, game.reason = ShogiGame.Result.HUMAN_WIN, "入玉宣言"
    game.save()
    _notify_end(game)
    return game


@transaction.atomic
def take_back(game_id: int) -> ShogiGame:
    """待った: 人の直前の手まで戻す（AI の手と合わせて 2 手）。"""
    game = _get_open(game_id)
    moves = game.move_list
    board = board_of(game)
    n = 2 if human_turn(game, board) else 1
    if len(moves) < n:
        raise DomainError("これ以上戻せません", code="cannot_undo")
    game.moves = " ".join(moves[:-n])
    game.last_ai = {}
    game.save()
    return game


def kif_moves(game: ShogiGame) -> list[str]:
    """棋譜を「▲７六歩(77)」の形で返す。"""
    b = cshogi.Board()
    out = []
    prev = None
    for u in game.move_list:
        m = b.move_from_usi(u)
        mark = "▲" if b.turn == cshogi.BLACK else "△"
        out.append(mark + KIF.move_to_kif(m, prev))
        b.push(m)
        prev = m
    return out
