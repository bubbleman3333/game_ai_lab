"""TypeScript 版オセロエンジンとの一致を確かめるテストデータを作る。

実行: cd backend; python -m games.othello.fixtures
出力: shared/fixtures/othello/engine_cases.json
    games:     ランダムな対局の棋譜・各局面の合法手・終局の盤面と石差
    eval:      決まった式で作った重みでの評価値（パターンの番号の付け方が一致するかの確認）
    spec:      パターン定義（rl.othello.ntuple.spec()）
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np

from .board import Position, bits, sq_to_str, str_to_sq

OUT = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "othello" / "engine_cases.json"


def formula_weights(stages: int, table_size: int) -> np.ndarray:
    """テスト用の重み。TS 側も同じ式で作る: ((i*7919 + s*104729) % 2001) / 1000 - 1"""
    i = np.arange(table_size, dtype=np.int64)
    return np.stack([((i * 7919 + s * 104729) % 2001) / 1000 - 1 for s in range(stages)]).astype(np.float32)


def _random_game(seed: int) -> dict:
    rng = random.Random(seed)
    pos = Position.initial()
    moves: list[str] = []
    legal: list[list[str]] = []
    while not pos.is_over():
        ms = list(bits(pos.moves()))
        legal.append([sq_to_str(s) for s in ms])
        sq = rng.choice(ms)
        moves.append(sq_to_str(sq))
        pos = pos.play(sq).normalize()
    return {
        "seed": seed, "moves": "".join(moves), "legal": legal,
        "final_board": pos.to_strings(), "final_black_to_move": pos.black_to_move,
        "final_score_for_side_to_move": pos.final_score(),
    }


def build() -> dict:
    from rl.othello.ntuple import N_STAGES, TABLE_SIZE, NTupleNet, spec

    games = [_random_game(s) for s in range(12)]
    net = NTupleNet(formula_weights(N_STAGES, TABLE_SIZE))
    rng = random.Random(99)
    evals = []
    for g in games[:4]:
        pos = Position.initial()
        for i in range(0, len(g["moves"]), 2):
            if rng.random() < 0.3:
                evals.append({"board": pos.to_strings(), "black_to_move": pos.black_to_move,
                              "value": net.evaluate(pos)})
            pos = pos.play(str_to_sq(g["moves"][i : i + 2])).normalize()
    return {"games": games, "eval": evals, "spec": spec()}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build()), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
