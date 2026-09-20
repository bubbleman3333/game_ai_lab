"""AI 同士の対戦。オンライン対戦と同じルールで、出した火力を相手におじゃまとして送る。

強さを「火力の平均」ではなく **勝率** で測るために使う。火力や生存率は打ち切りの手数で
頭打ちになり、ある程度強くなると差が出なくなるが、勝率には上限がない。

おじゃまの送り方は `frontend/src/games/tetris/game/versus.ts`（同じ画面での対戦）と同じで、
固定の結果の `sent`（相殺後に相手へ送る段数）をそのまま相手に渡す。
"""

from __future__ import annotations

from dataclasses import dataclass

from games.tetris import Game, LockResult

from .agent import Agent
from .position import Position

VERSUS_SEED_BASE = 30_000


@dataclass
class MatchResult:
    """対戦 1 局の結果。各項目は (先に打つ側, 後に打つ側) の順。"""

    winner: int | None  # 0 = 先に打つ側の勝ち、1 = 後に打つ側の勝ち、None = 引き分け（手数上限）
    pieces: tuple[int, int]
    lines: tuple[int, int]
    attack: tuple[int, int]


class _Side:
    """対戦中の片側。"""

    def __init__(self, agent: Agent, seed: int):
        self.agent = agent
        self.game = Game(seed=seed)

    def play_piece(self) -> int:
        """1 手打って、相手に送る段数を返す。置く場所がなければ負け扱いにする。"""
        c = self.agent.choose(Position.from_game(self.game))
        if c is None:
            self.game.over = True
            return 0
        sent = 0
        for a in c.path:
            r = self.game.apply(a)
            if a == "HD":
                assert isinstance(r, LockResult)
                sent = r.sent
        return sent


def play_match(a: Agent, b: Agent, seed: int, max_pieces: int = 300) -> MatchResult:
    """a と b を 1 局戦わせる。オンライン対戦と同じく、両者のツモ順は同じ（同じ seed）。

    実際の対戦は同時に進むが、ここでは a → b → a … と 1 手ずつ交互に打つ。
    先に打つ側がわずかに有利なので、勝率を測るときは `match()` のように順番を入れ替えて行う。
    どちらも `max_pieces` 手まで生き残ったら引き分け。
    """
    sides = (_Side(a, seed), _Side(b, seed))
    turn = 0
    while not any(s.game.over for s in sides) and max(s.game.stats.pieces for s in sides) < max_pieces:
        sent = sides[turn].play_piece()
        other = sides[1 - turn]
        if sent > 0 and not other.game.over:
            other.game.receive_garbage(sent)
        turn = 1 - turn

    over = [s.game.over for s in sides]
    winner = None if over[0] == over[1] else (1 if over[0] else 0)
    stats = [s.game.stats for s in sides]
    return MatchResult(
        winner=winner,
        pieces=(stats[0].pieces, stats[1].pieces),
        lines=(stats[0].lines, stats[1].lines),
        attack=(stats[0].attack, stats[1].attack),
    )


def match(a: Agent, b: Agent, games: int = 6, seed: int = VERSUS_SEED_BASE, max_pieces: int = 300) -> dict:
    """a から見た成績。同じツモ順で打つ順番を入れ替えて 2 局ずつ行う（`games` は偶数に切り上げ）。

    戻り値の `win_rate` は引き分けを 0.5 勝として数える（オセロの評価と同じ）。
    """
    pairs = max(1, games // 2)
    wins = draws = 0
    attack = taken = pieces = 0
    for i in range(pairs):
        for a_first in (True, False):
            r = play_match(a, b, seed + i, max_pieces) if a_first else play_match(b, a, seed + i, max_pieces)
            me, opp = (0, 1) if a_first else (1, 0)
            if r.winner is None:
                draws += 1
            elif r.winner == me:
                wins += 1
            attack += r.attack[me]
            taken += r.attack[opp]
            pieces += r.pieces[me]
    n = pairs * 2
    return {
        "games": n,
        "win_rate": (wins + 0.5 * draws) / n,
        "draw_rate": draws / n,
        "avg_attack": attack / n,  # 自分が出した火力
        "avg_attack_taken": taken / n,  # 相手に出された火力
        "avg_pieces": pieces / n,
    }
