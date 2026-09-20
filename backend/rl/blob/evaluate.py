"""AI の強さを測る。決まった seed で何ゲームか遊ばせて平均を取る。

実行例:
    python -m rl.blob.evaluate runs/blob/v1/checkpoints/best.pt --games 20
    python -m rl.blob.evaluate heuristic --save-run heuristic-baseline
        # 比較用のヒューリスティック AI を測って runs/blob/heuristic-baseline/ に保存する
        # （強さページがこの名前の結果を基準線として表示する）
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .agent import Agent, HeuristicAgent, NeuralAgent
from .env import BlobEnv

# 評価モード: 名前 -> 1 手あたりに送られてくるおじゃまの期待個数
EVAL_MODES: dict[str, float] = {"solo": 0.0, "pressure": 0.6}
EVAL_SEED_BASE = 10_000
BIG_CHAIN = 6  # 何段から「大連鎖」と数えるか


def play_game(agent: Agent, seed: int, max_pairs: int, garbage_rate: float) -> dict:
    env = BlobEnv(max_pairs=max_pairs, garbage_rate=garbage_rate, seed=seed)
    env.reset(seed)
    while not env.done:
        c = agent.choose(env.position())
        if c is None:
            break
        env.step(c)
    g = env.game
    return {
        "pairs": g.stats.pairs, "sent": g.stats.sent, "score": g.score, "max_chain": g.max_chain,
        "all_clears": g.stats.all_clears, "survived": not g.over, **env.chain_stats(BIG_CHAIN),
    }


def evaluate(agent: Agent, games: int = 10, max_pairs: int = 200, modes: dict[str, float] | None = None) -> dict:
    """戻り値: {モード名: {平均値...}}。強さページ（/blob/stats）はこの形をそのまま表示する。"""
    result: dict[str, dict] = {}
    for mode, rate in (modes or EVAL_MODES).items():
        rows = [play_game(agent, EVAL_SEED_BASE + i, max_pairs, rate) for i in range(games)]
        pairs = sum(r["pairs"] for r in rows) or 1
        result[mode] = {
            "games": games,
            "max_pairs": max_pairs,
            "avg_pairs": sum(r["pairs"] for r in rows) / games,
            "avg_sent": sum(r["sent"] for r in rows) / games,
            "avg_score": sum(r["score"] for r in rows) / games,
            "avg_max_chain": sum(r["max_chain"] for r in rows) / games,
            "best_chain": max(r["max_chain"] for r in rows),
            # 連鎖の組み方（方針 A で増やした項目）
            "avg_fire_chain": sum(r["avg_fire_chain"] for r in rows) / games,
            "big_chains_per_game": sum(r["big_chains"] for r in rows) / games,
            "small_fires_per_game": sum(r["small_fires"] for r in rows) / games,
            "fires_per_game": sum(r["fires"] for r in rows) / games,
            "sent_per_pair": sum(r["sent"] for r in rows) / pairs,
            "all_clears_per_game": sum(r["all_clears"] for r in rows) / games,
            "survival_rate": sum(r["survived"] for r in rows) / games,
        }
    return result


def strength_score(res: dict, style: str = "chain") -> float:
    """best.pt を選ぶための 1 つの数値。**学習のスタイルごとに「良さ」の定義が違う**。

    versus: 対戦の強さ。送ったおじゃまの数と生き残りをそのまま見る。
    chain:  連鎖の組み方。おじゃまの数は 1/20 に薄めて（そのまま足すと小さい連鎖を
            たくさん撃つ AI が勝ってしまう）、大連鎖の回数と発火の平均段数を主役にする。
            組みかけを壊す発火（2 連鎖以下）は引き算する。
    """
    if style == "versus":
        return sum(m["avg_sent"] + 20 * m["survival_rate"] + 2 * m["avg_max_chain"] for m in res.values())
    return sum(
        10 * m["avg_max_chain"]
        + 8 * m["big_chains_per_game"]
        + 5 * m["avg_fire_chain"]
        - 1 * m["small_fires_per_game"]
        + 20 * m["survival_rate"]
        + 0.05 * m["avg_sent"]
        for m in res.values()
    )


def load_agent(target: str, device: str = "cpu", lookahead: int = 0, beam: int = 8) -> Agent:
    if target == "heuristic":
        return HeuristicAgent()
    return NeuralAgent.load(Path(target), device, lookahead=lookahead, beam=beam)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="チェックポイントのパス、または heuristic")
    ap.add_argument("--games", type=int, default=10)
    ap.add_argument("--max-pairs", type=int, default=200)
    ap.add_argument("--lookahead", type=int, default=0, help="1 なら NEXT の組まで読む（2 手先読み）")
    ap.add_argument("--beam", type=int, default=8, help="先読みする 1 手目の候補の数")
    ap.add_argument("--out", type=Path, help="結果を JSON で保存する先")
    ap.add_argument("--style", default="chain", choices=("chain", "versus"),
                    help="score の付け方（chain = 連鎖の組み方、versus = 対戦の強さ）")
    ap.add_argument("--save-run", help="runs/blob/<名前>/ に学習と同じ形式で保存する（強さページで見られる）")
    args = ap.parse_args()

    t = time.time()
    res = evaluate(load_agent(args.target, lookahead=args.lookahead, beam=args.beam), args.games, args.max_pairs)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    print(f"({time.time() - t:.1f}s)")
    if args.out:
        args.out.write_text(json.dumps(res, indent=2), encoding="utf-8")
    if args.save_run:
        _save_as_run(args.save_run, args.target, res, args.style)


def _save_as_run(name: str, target: str, res: dict, style: str = "chain") -> None:
    from datetime import datetime, timezone

    from .train import RUNS_DIR

    d = RUNS_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    (d / "config.json").write_text(json.dumps({"run_name": name, "evaluated": target}, indent=2), encoding="utf-8")
    (d / "status.json").write_text(json.dumps({"run_name": name, "state": "finished", "updated_at": now}), encoding="utf-8")
    row = {"episode": 0, "step": 0, "checkpoint": target, "score": strength_score(res, style),
           "is_best": True, "results": res, "at": now}
    (d / "evals.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    print(f"saved to {d}")


if __name__ == "__main__":
    main()
