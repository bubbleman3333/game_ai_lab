"""オセロ AI の強さを測る。決まった序盤（ランダムな数手）から、先手・後手を入れ替えて対戦させる。

実行例:
    python -m rl.othello.evaluate runs/othello/v1/checkpoints/best.npz --games 200
"""

from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

from games.othello.board import Position, bits

from .ntuple import NTupleNet
from .players import NTuplePlayer, Player, PositionalPlayer, RandomPlayer

OPENING_RANDOM_MOVES = 4  # 序盤をばらけさせるため、最初の数手はランダム
EVAL_SEED = 20240


def random_opening(rng: random.Random) -> Position:
    pos = Position.initial()
    for _ in range(OPENING_RANDOM_MOVES):
        pos = pos.play(rng.choice(list(bits(pos.moves())))).normalize()
    return pos


def play_game(black: Player, white: Player, start: Position) -> int:
    """黒から見た最終石差を返す。"""
    pos = start.normalize()
    while not pos.is_over():
        player = black if pos.black_to_move else white
        pos = pos.play(player.choose(pos)).normalize()
    score = pos.final_score()
    return score if pos.black_to_move else -score


def match(a: Player, b: Player, pairs: int, seed: int = EVAL_SEED) -> dict:
    """同じ序盤で先後を入れ替えて 2 局ずつ。a から見た勝率と平均石差。"""
    rng = random.Random(seed)
    wins = draws = 0
    diff = 0
    for _ in range(pairs):
        start = random_opening(rng)
        for a_is_black in (True, False):
            d = play_game(a, b, start) if a_is_black else -play_game(b, a, start)
            diff += d
            wins += d > 0
            draws += d == 0
    games = pairs * 2
    return {"games": games, "win_rate": (wins + 0.5 * draws) / games, "avg_disc_diff": diff / games}


def default_opponents() -> list[Player]:
    return [RandomPlayer(1), PositionalPlayer(1, 2), PositionalPlayer(2, 3)]


def evaluate(net: NTupleNet, pairs: dict[str, int] | None = None) -> dict:
    """戻り値: {相手の名前: {games, win_rate, avg_disc_diff}}。強さページはこの形を表示する。"""
    pairs = pairs or {"random": 50, "positional-d1": 50, "positional-d2": 25}
    me = NTuplePlayer(net)
    return {opp.name: match(me, opp, pairs.get(opp.name, 25)) for opp in default_opponents()}


def strength_score(res: dict) -> float:
    """best を選ぶための 1 つの数値（強い相手への勝率を重く見る）。"""
    w = {"random": 0.1, "positional-d1": 0.4, "positional-d2": 1.0}
    return sum(w.get(k, 0.5) * v["win_rate"] for k, v in res.items())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint", type=Path)
    ap.add_argument("--games", type=int, default=100, help="各相手との対局数（偶数）")
    args = ap.parse_args()
    t = time.time()
    n = max(1, args.games // 2)
    res = evaluate(NTupleNet.load(args.checkpoint), {"random": n, "positional-d1": n, "positional-d2": n})
    print(json.dumps(res, indent=2, ensure_ascii=False))
    print(f"({time.time() - t:.1f}s)")


if __name__ == "__main__":
    main()
