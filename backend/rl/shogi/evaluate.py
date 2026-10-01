"""2 つの将棋 AI を対局させて強さを比べる。

実行例:
    python -m rl.shogi.evaluate --a v2:best --b v1:best --games 40 --time 0.5
    python -m rl.shogi.evaluate --a v1:best --b v1:best --b-playouts 800 --games 20   # 読む回数を変えて比べる

開始局面は、テスト用の棋譜から「互角（評価値 ±100 以内）」の局面を選び、先手・後手を入れ替えて 2 局ずつ指す
（同じ局面で両方の手番を持つので、局面の有利不利が打ち消される）。
勝率から Elo の差（+ なら A が強い）も出す。勝率 76% ≈ +200、91% ≈ +400。
"""

from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import numpy as np
import torch
from cshogi import BLACK, REPETITION_DRAW, REPETITION_LOSE, REPETITION_WIN, Board, HuffmanCodedPosAndEval

from ..common import runs_dir
from .mcts import MCTS
from .model import load

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "shogi" / "hcpe"
RESIGN_WINRATE = 0.02  # 指す側の勝率の予想がこれを下回ったら投了
MAX_PLY = 320


def model_path(agent_id: str) -> Path:
    """"v2:best" → runs/shogi/v2/checkpoints/best.pt"""
    run, _, kind = agent_id.partition(":")
    return runs_dir("shogi") / run / "checkpoints" / f"{kind or 'best'}.pt"


def openings(n: int, seed: int = 0) -> list[str]:
    """互角の局面を n 個（sfen）。"""
    recs = np.fromfile(sorted(DATA_DIR.glob("*_test.hcpe"))[0], dtype=HuffmanCodedPosAndEval)
    rng = np.random.default_rng(seed)
    b = Board()
    out: list[str] = []
    for i in rng.permutation(len(recs)):
        r = recs[i]
        if r["eval"] == 0 or abs(int(r["eval"])) > 100:
            continue
        b.set_hcp(np.ascontiguousarray(r["hcp"]))
        if b.is_check():
            continue
        out.append(b.sfen())
        if len(out) >= n:
            break
    return out


class Player:
    def __init__(self, agent_id: str, device: torch.device, time_limit: float, playouts: int, batch: int):
        model, _ = load(model_path(agent_id), device)
        self.name = agent_id
        self.mcts = MCTS(model, device, batch_size=batch)
        self.time_limit, self.playouts = time_limit, playouts

    def think(self, board: Board):
        return self.mcts.search(board, playouts=self.playouts, time_limit=self.time_limit)


def play_game(black, white, sfen: str) -> tuple[int, str, int]:
    """1 局指す。戻り値: (先手から見た結果 1 / 0.5 / 0, 終わり方, 手数)"""
    board = Board(sfen)
    for p in (black, white):
        p.mcts.clear()
    for ply in range(MAX_PLY):
        rep = board.is_draw(16)
        if rep == REPETITION_DRAW:
            return 0.5, "千日手", ply
        if rep in (REPETITION_LOSE, REPETITION_WIN):  # 連続王手の千日手
            side_wins = rep == REPETITION_WIN
            return float(side_wins == (board.turn == BLACK)), "連続王手", ply
        if board.is_game_over():
            return float(board.turn != BLACK), "詰み", ply
        mover = black if board.turn == BLACK else white
        r = mover.think(board)
        if r.move == "win":
            return float(board.turn == BLACK), "入玉宣言", ply
        if r.winrate < RESIGN_WINRATE and not r.mate:
            return float(board.turn != BLACK), "投了", ply
        board.push_usi(r.move)
    return 0.5, "手数上限", MAX_PLY


def elo(score: float) -> float:
    score = min(max(score, 1e-3), 1 - 1e-3)
    return -400 * math.log10(1 / score - 1)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--games", type=int, default=20, help="対局数（偶数。開始局面 1 つにつき 2 局）")
    ap.add_argument("--time", type=float, default=0.5, help="1 手の時間（秒）")
    ap.add_argument("--a-playouts", type=int, default=10**8)
    ap.add_argument("--b-playouts", type=int, default=10**8)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    a = Player(args.a, device, args.time, args.a_playouts, args.batch)
    b = Player(args.b, device, args.time, args.b_playouts, args.batch)
    score = 0.0
    w = d = l = 0
    started = time.time()
    for g, sfen in enumerate(openings(args.games // 2, args.seed)):
        for a_black in (True, False):
            res, how, ply = play_game(a, b, sfen) if a_black else play_game(b, a, sfen)
            s = res if a_black else 1 - res
            score += s
            w, d, l = w + (s == 1), d + (s == 0.5), l + (s == 0)
            n = w + d + l
            print(f"{n:3d} 局目: A={'先手' if a_black else '後手'} {'勝ち' if s == 1 else '負け' if s == 0 else '引分'}"
                  f"（{how}・{ply} 手）  通算 A {w}勝 {l}敗 {d}分  勝率 {score / n:.1%}  Elo {elo(score / n):+.0f}"
                  f"  [{time.time() - started:.0f} 秒]", flush=True)


if __name__ == "__main__":
    main()
