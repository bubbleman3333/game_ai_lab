"""floodgate の棋譜（CSA）を、学習用の局面データ（hcpe 形式）に変換する。

実行例:
    python -m rl.shogi.prepare data/shogi/floodgate2025 --min-rating 3500

出力（data/shogi/hcpe/）:
    <名前>_train.hcpe / <名前>_test.hcpe   局面ごとに「局面・その局面で指された手・勝敗・評価値」
    （対局単位で 95% / 5% に分ける。同じ対局の局面が両方に入らないようにするため）

hcpe は dlshogi で使われている形式（cshogi.HuffmanCodedPosAndEval。1 局面 38 バイト）。
"""

from __future__ import annotations

import argparse
import random
import time
from pathlib import Path

import numpy as np
from cshogi import CSA, BLACK_WIN, DRAW, WHITE_WIN, Board, HuffmanCodedPosAndEval, move16

OUT_DIR = Path(__file__).resolve().parents[2] / "data" / "shogi" / "hcpe"
MIN_MOVES = 50  # 短すぎる対局（接続切れなど）は使わない
GOOD_ENDINGS = {"%TORYO", "%KACHI", "%SENNICHITE", "%JISHOGI"}


def convert(files: list[Path], min_rating: float) -> tuple[list[np.ndarray], dict]:
    games: list[np.ndarray] = []
    stats = {"files": len(files), "used": 0, "skipped_rating": 0, "skipped_other": 0, "positions": 0}
    board = Board()
    for i, f in enumerate(files):
        try:
            p = CSA.Parser.parse_file(str(f))[0]
        except Exception:  # 壊れたファイルは飛ばす
            stats["skipped_other"] += 1
            continue
        if min(p.ratings or [0]) < min_rating:
            stats["skipped_rating"] += 1
            continue
        if p.endgame not in GOOD_ENDINGS or len(p.moves) < MIN_MOVES:
            stats["skipped_other"] += 1
            continue
        board.set_sfen(p.sfen)
        rec = np.zeros(len(p.moves), HuffmanCodedPosAndEval)
        result = {1: BLACK_WIN, 2: WHITE_WIN}.get(p.win, DRAW)
        ok = True
        for k, (m, score) in enumerate(zip(p.moves, p.scores)):
            if not board.is_legal(m):
                ok = False
                break
            board.to_hcp(rec[k]["hcp"])
            rec[k]["eval"] = int(np.clip(score, -32000, 32000)) if score is not None else 0
            rec[k]["bestMove16"] = move16(m)
            rec[k]["gameResult"] = result
            board.push(m)
        if not ok:
            stats["skipped_other"] += 1
            continue
        games.append(rec)
        stats["used"] += 1
        stats["positions"] += len(rec)
        if (i + 1) % 10000 == 0:
            print(f"  {i + 1:,} / {len(files):,} 局  使用 {stats['used']:,} 局  {stats['positions']:,} 局面", flush=True)
    return games, stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="CSA ファイルがあるフォルダ（中のフォルダも探す）")
    ap.add_argument("--min-rating", type=float, default=3500, help="両者ともこのレーティング以上の対局だけ使う")
    ap.add_argument("--name", default=None, help="出力ファイル名（既定はフォルダ名）")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    t = time.time()
    files = sorted(args.src.rglob("*.csa"))
    print(f"{len(files):,} 局を読み込みます")
    games, stats = convert(files, args.min_rating)
    random.Random(args.seed).shuffle(games)
    n_test = max(1, len(games) // 20)
    name = args.name or args.src.name
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for part, gs in (("test", games[:n_test]), ("train", games[n_test:])):
        arr = np.concatenate(gs)
        arr.tofile(OUT_DIR / f"{name}_{part}.hcpe")
        print(f"{part}: {len(gs):,} 局 / {len(arr):,} 局面 → {OUT_DIR / f'{name}_{part}.hcpe'}")
    print(stats, f"({time.time() - t:.0f}s)")


if __name__ == "__main__":
    main()
