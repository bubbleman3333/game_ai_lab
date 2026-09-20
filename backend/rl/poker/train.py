"""ポーカー（ヘッズアップ・ノーリミット）の学習。

    cd backend
    .\\.venv\\Scripts\\python -m rl.poker.train --run-name v1
    .\\.venv\\Scripts\\python -m rl.poker.train --run-name v1 --resume --traversals 10000000
    .\\.venv\\Scripts\\python -m rl.poker.train --run-name v1-100bb --depth 2   # 深さを 1 つに絞る
    .\\.venv\\Scripts\\python -m rl.poker.train --help

外部サンプリング MCCFR（`mccfr.py`）を回す。学習結果は
`runs/poker/<名前>/` に、ほかのゲームと同じ形式で書く:
config.json / metrics.jsonl / evals.jsonl / status.json / checkpoints/*.npz。
`python manage.py sync_runs` で強さページに出る。

**速くしたいとき**: スタックの深さごとに表が完全に分かれている（情報集合の鍵の先頭が深さ）ので、
`--depth 0`〜`--depth 5` を**別々のプロセスで同時に走らせて**から
`python -m rl.poker.merge` でまとめれば、そのまま台数分速くなる。
1 プロセスで `--depth all` にすると深さを順番に回すので、同じ時間なら 1/6 ずつしか進まない。
"""

from __future__ import annotations

import argparse
import json
import random
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from games.poker.cards import Rng
from ..common import append_jsonl, now_iso, runs_dir, write_json
from . import config, evaluate, mccfr, players

RUNS_DIR = runs_dir("poker")


@dataclass
class TrainConfig:
    run_name: str = "v1"
    traversals: int = config.DEFAULT_TRAVERSALS
    depth: str = "all"  # "all" か "0"〜（config.STACK_DEPTHS_BB の番号）
    seed: int = 1
    eval_every: int = config.EVAL_EVERY
    eval_hands: int = 4_000
    eval_matches: int = 30
    snapshot_every: int = 1_000_000  # 世代として別に残す間隔（あとで並べて比べるため）
    log_every: int = 2_000


def _depth_indexes(spec: str) -> list[int]:
    if spec == "all":
        return list(range(len(config.STACK_DEPTHS_BB)))
    index = int(spec)
    if not 0 <= index < len(config.STACK_DEPTHS_BB):
        raise SystemExit(f"--depth は all か 0〜{len(config.STACK_DEPTHS_BB) - 1}")
    return [index]


class Trainer:
    def __init__(self, cfg: TrainConfig, resume: bool = False):
        self.cfg = cfg
        self.depths = _depth_indexes(cfg.depth)
        self.dir = RUNS_DIR / cfg.run_name
        self.table = mccfr.Table()
        self.done = 0
        self.best = float("-inf")
        self.started = time.time()
        latest = self.dir / "checkpoints" / "latest.npz"
        if resume and latest.exists():
            self.table = mccfr.load(latest)
            status = self._read_status()
            self.done = status.get("episode", 0)
            self.best = status.get("best") if status.get("best") is not None else float("-inf")
            print(f"{self.done} 回目から続ける（情報集合 {len(self.table):,} 個）")

    def _read_status(self) -> dict:
        try:
            return json.loads((self.dir / "status.json").read_text(encoding="utf-8"))
        except OSError:
            return {}

    def _status(self, state: str) -> None:
        write_json(self.dir / "status.json", {
            "run_name": self.cfg.run_name,
            "state": state,
            "episode": self.done,
            "episodes": self.cfg.traversals,
            "best": self.best if self.best != float("-inf") else None,
            "infosets": len(self.table),
            "workers": 0,
            "elapsed_sec": round(time.time() - self.started, 1),
            "updated_at": now_iso(),
        })

    def _meta(self) -> dict:
        return {
            "episode": self.done,
            "depths": self.depths,
            "abstraction_version": config.ABSTRACTION_VERSION,
            "config": config.config_dict(),
        }

    def _avg_positive_regret(self, sample: int = 3000) -> float:
        """後悔の大きさの目安。落ち着いてくれば戦略が固まってきている。"""
        total = 0.0
        n = 0
        for key, r in self.table.regret.items():
            total += sum(r)
            n += 1
            if n >= sample:
                break
        return total / max(1, n)

    def _evaluate(self) -> None:
        """基準の相手と対戦して強さを測り、evals.jsonl に書く。

        結果の鍵は**スタックの深さに依存しない名前**にする（`vs_heuristic` など）。
        深さごとの内訳は `by_depth` に入れる。こうしておくと、深さ別に分けて学習しても
        強さページが同じ設定で読める。
        """
        t0 = time.time()
        strategy = mccfr.Strategy.from_table(self.table, self._meta())
        by_depth: dict[str, dict] = {}
        totals: dict[str, list[float]] = {}
        for depth in self.depths:
            bb = config.STACK_DEPTHS_BB[depth]
            stack = bb * 2
            me = players.strategy_player(strategy, seed=self.done + depth)
            here: dict[str, dict] = {}
            for name in ("random", "caller", "heuristic", "heuristic-loose"):
                opponent = players.BASELINES[name](self.done + depth)
                r = evaluate.head_to_head(me, opponent, hands=self.cfg.eval_hands,
                                          seed=self.done + depth + 1, start_stack=stack)
                here[f"vs_{name}"] = r.as_dict()
                totals.setdefault(f"vs_{name}", []).append(r.mbb_per_hand)
            # 「簡単に退場しないか」は別に測る（スタックを持ち越して飛ぶまで打つ）
            surv = evaluate.survival(me, players.BASELINES["heuristic"](self.done),
                                     matches=self.cfg.eval_matches, start_stack=stack,
                                     max_hands=200, seed=self.done + 7)
            here["survival"] = surv.as_dict()
            totals.setdefault("bust_rate", []).append(surv.bust_rate)
            by_depth[f"{bb}bb"] = here

        results: dict[str, dict] = {"by_depth": by_depth}
        for name, values in totals.items():
            mean = sum(values) / len(values)
            if name == "bust_rate":
                results["survival"] = {"bust_rate": round(mean, 4)}
            else:
                results[name] = {"mbb_per_hand": round(mean, 1)}
        # 「一番よい学習結果」を選ぶ 1 つの数字: 全部の相手・全部の深さに対する mbb/hand の平均
        vs_means = [results[k]["mbb_per_hand"] for k in results if k.startswith("vs_")]
        score = sum(vs_means) / max(1, len(vs_means))

        is_best = score > self.best
        ckpt = self.dir / "checkpoints"
        mccfr.save(ckpt / "latest.npz", self.table, self._meta())
        if is_best:
            self.best = score
            mccfr.save(ckpt / "best.npz", self.table, self._meta(), average_only=True)
        append_jsonl(self.dir / "evals.jsonl", {
            "episode": self.done,
            "step": self.done,
            "checkpoint": "best.npz" if is_best else "latest.npz",
            "score": round(score, 1),
            "is_best": is_best,
            "infosets": len(self.table),
            "results": results,
            "eval_sec": round(time.time() - t0, 1),
            "at": now_iso(),
        })
        shown = {k: v.get("mbb_per_hand", v.get("bust_rate")) for k, v in results.items()
                 if k != "by_depth"}
        print(f"  [評価] {self.done:,} 回 score={score:.1f} mbb/hand (最良 {self.best:.1f}) {shown}")
        self._status("running")

    def _snapshot(self) -> None:
        name = f"iter_{self.done:09d}.npz"
        mccfr.save(self.dir / "checkpoints" / name, self.table, self._meta(), average_only=True)
        print(f"  [世代を保存] {name}")

    def train(self) -> None:
        write_json(self.dir / "config.json", {**asdict(self.cfg), **config.config_dict()})
        depths_bb = [config.STACK_DEPTHS_BB[d] for d in self.depths]
        print(f"run={self.cfg.run_name} スタックの深さ={depths_bb}BB 目標={self.cfg.traversals:,} 回")
        deck_rng = Rng(self.cfg.seed + self.done)
        rng = random.Random(self.cfg.seed + self.done)
        state = "running"
        try:
            while self.done < self.cfg.traversals:
                self.done += 1
                depth = self.depths[(self.done - 1) % len(self.depths)]
                mccfr.run_iteration(self.table, deck_rng, rng, self.done, depth)
                if self.done % self.cfg.log_every == 0:
                    self._log()
                if self.done % self.cfg.eval_every == 0:
                    self._evaluate()
                if self.done % self.cfg.snapshot_every == 0:
                    self._snapshot()
            state = "finished"
        except KeyboardInterrupt:
            state = "stopped"
            print("中断しました（latest.npz から --resume で続けられます）")
        mccfr.save(self.dir / "checkpoints" / "latest.npz", self.table, self._meta())
        self._status(state)

    def _log(self) -> None:
        rate = self.done / max(1e-9, time.time() - self.started)
        row = {
            "episode": self.done,
            "infosets": len(self.table),
            "avg_regret": round(self._avg_positive_regret(), 3),
            "rate": round(rate, 1),
            "at": now_iso(),
        }
        append_jsonl(self.dir / "metrics.jsonl", row)
        print(f"{self.done:9,} 回  情報集合 {len(self.table):8,}  後悔 {row['avg_regret']:7.2f}  ({rate:.0f} 回/秒)")
        self._status("running")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    default = TrainConfig()
    for f in fields(default):
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(default, f.name)),
                        default=getattr(default, f.name))
    ap.add_argument("--resume", action="store_true", help="latest.npz から続ける")
    args = ap.parse_args()
    cfg = TrainConfig(**{f.name: getattr(args, f.name) for f in fields(default)})
    Trainer(cfg, resume=args.resume).train()


if __name__ == "__main__":
    main()
