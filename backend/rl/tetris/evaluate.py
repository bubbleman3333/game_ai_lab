"""AI の強さを測る。決まった seed で何ゲームか遊ばせて平均を取る。

実行例:
    python -m rl.tetris.evaluate runs/default/checkpoints/latest.pt --games 20
    python -m rl.tetris.evaluate heuristic --save-run heuristic-baseline
        # 比較用のヒューリスティック AI を測って runs/heuristic-baseline/ に保存する
        # （強さページがこの名前の結果を基準線として表示する）
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .agent import Agent, HeuristicAgent, NeuralAgent
from .env import TetrisEnv

# 評価モード: 名前 -> 1 手あたりに送られてくるおじゃまの期待段数
EVAL_MODES: dict[str, float] = {"solo": 0.0, "pressure": 0.4}
EVAL_SEED_BASE = 10_000


def play_game(agent: Agent, seed: int, max_pieces: int, garbage_rate: float) -> dict:
    env = TetrisEnv(max_pieces=max_pieces, garbage_rate=garbage_rate, seed=seed)
    env.reset(seed)
    while not env.done:
        c = agent.choose(env.position())
        if c is None:
            break
        env.step(c)
    s = env.game.stats
    return {
        "pieces": s.pieces, "lines": s.lines, "attack": s.attack, "tspin_clears": s.tspin_clears,
        "tetrises": s.tetrises, "perfect_clears": s.perfect_clears, "max_combo": s.max_combo,
        "survived": not env.game.over,
    }


def evaluate(agent: Agent, games: int = 10, max_pieces: int = 300, modes: dict[str, float] | None = None) -> dict:
    """戻り値: {モード名: {平均値...}}。強さページ（/stats）はこの形をそのまま表示する。"""
    result: dict[str, dict] = {}
    for mode, rate in (modes or EVAL_MODES).items():
        rows = [play_game(agent, EVAL_SEED_BASE + i, max_pieces, rate) for i in range(games)]
        pieces = sum(r["pieces"] for r in rows) or 1
        result[mode] = {
            "games": games,
            "max_pieces": max_pieces,
            "avg_pieces": sum(r["pieces"] for r in rows) / games,
            "avg_lines": sum(r["lines"] for r in rows) / games,
            "avg_attack": sum(r["attack"] for r in rows) / games,
            "attack_per_piece": sum(r["attack"] for r in rows) / pieces,
            "tspins_per_100": 100 * sum(r["tspin_clears"] for r in rows) / pieces,
            "tetrises_per_100": 100 * sum(r["tetrises"] for r in rows) / pieces,
            "survival_rate": sum(r["survived"] for r in rows) / games,
        }
    return result


def strength_score(res: dict) -> float:
    """best.pt を選ぶための 1 つの数値。火力を重視し、同点なら消した列数で比べる。"""
    return sum(m["avg_attack"] + 0.1 * m["avg_lines"] for m in res.values())


def load_agent(target: str, device: str = "cpu", lookahead: int = 0, beam: int = 8) -> Agent:
    if target == "heuristic":
        return HeuristicAgent()
    return NeuralAgent.load(Path(target), device, lookahead=lookahead, beam=beam)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="チェックポイントのパス、または heuristic")
    ap.add_argument("--games", type=int, default=10)
    ap.add_argument("--max-pieces", type=int, default=300)
    ap.add_argument("--lookahead", type=int, default=0, help="1 なら NEXT のミノまで読む（2 手先読み）")
    ap.add_argument("--beam", type=int, default=8, help="先読みする 1 手目の候補の数")
    ap.add_argument("--out", type=Path, help="結果を JSON で保存する先")
    ap.add_argument("--save-run", help="runs/<名前>/ に学習と同じ形式で保存する（強さページで見られる）")
    args = ap.parse_args()

    t = time.time()
    res = evaluate(load_agent(args.target, lookahead=args.lookahead, beam=args.beam), args.games, args.max_pieces)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    print(f"({time.time() - t:.1f}s)")
    if args.out:
        args.out.write_text(json.dumps(res, indent=2), encoding="utf-8")
    if args.save_run:
        _save_as_run(args.save_run, args.target, res)


def _save_as_run(name: str, target: str, res: dict) -> None:
    from datetime import datetime, timezone

    from .train import RUNS_DIR

    d = RUNS_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    (d / "config.json").write_text(json.dumps({"run_name": name, "evaluated": target}, indent=2), encoding="utf-8")
    (d / "status.json").write_text(json.dumps({"run_name": name, "state": "finished", "updated_at": now}), encoding="utf-8")
    row = {"episode": 0, "step": 0, "checkpoint": target, "score": strength_score(res),
           "is_best": True, "results": res, "at": now}
    (d / "evals.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    print(f"saved to {d}")


if __name__ == "__main__":
    main()
