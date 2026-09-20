"""ポーカー AI の学習（Deep CFR・ニューラルネット）。

    cd backend
    .\\.venv\\Scripts\\python -m rl.poker.train_deep --run-name n1
    .\\.venv\\Scripts\\python -m rl.poker.train_deep --run-name n1 --resume
    .\\.venv\\Scripts\\python -m rl.poker.train_deep --run-name dbg --workers 0   # 1 プロセス（デバッガで追う）
    .\\.venv\\Scripts\\python -m rl.poker.train_deep --help

表形式の `train.py` と違い、**1 つのネットで全部のスタックの深さを扱う**ので、
学習を深さごとに分ける必要が無い。対局ごとに深さを 10〜200BB から選んで経験させる。

1 反復の流れ:

1. 木をたどって学習のもとを集める（複数プロセス。ネットは numpy 版を配る）
2. advantage ネットを**まっさらから**学習し直す（Deep CFR の作法）
3. ときどき strategy ネット（＝実際に遊ぶ平均戦略）も学習して、強さを測って保存する

学習結果は `runs/poker/<名前>/`（ほかのゲームと同じ形式）。`python manage.py sync_runs` で
`/poker/stats` に出る。
"""

from __future__ import annotations

import os

# numpy と torch を読む前に入れる。小さな行列ばかり扱うので、スレッドを起こす手間の方が高くつく
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import argparse  # noqa: E402
import json  # noqa: E402
import multiprocessing as mp  # noqa: E402
import time  # noqa: E402
from dataclasses import asdict, dataclass, fields  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import torch  # noqa: E402
from torch import nn  # noqa: E402

from games.poker.rules import BIG_BLIND  # noqa: E402
from ..common import append_jsonl, now_iso, runs_dir, write_json  # noqa: E402
from . import deep_cfr, evaluate, players  # noqa: E402
from .deep_cfr import DeepConfig, N_ACTIONS, Reservoir, collect  # noqa: E402
from .encoding import FEATURE_VERSION, N_FEATURES  # noqa: E402
from .model import PokerNet, zero_net  # noqa: E402

RUNS_DIR = runs_dir("poker")


@dataclass
class TrainConfig:
    run_name: str = "n1"
    iterations: int = 400
    traversals_per_iter: int = 6_000  # 1 反復・1 人あたりの対局数
    workers: int = 12
    hidden: int = 256
    layers: int = 3
    adv_memory: int = 400_000
    strategy_memory: int = 1_200_000
    adv_steps: int = 1_500
    adv_batch: int = 4_096
    adv_lr: float = 1e-3
    strategy_steps: int = 6_000
    strategy_batch: int = 4_096
    strategy_lr: float = 1e-3
    min_stack_bb: float = 10.0
    max_stack_bb: float = 200.0
    eval_every: int = 10  # 何反復ごとに strategy ネットを作って強さを測るか
    snapshot_every: int = 250  # 何反復ごとに世代として別名で残すか（あとで並べて比べる）
    eval_hands: int = 20_000  # 少ないとブレて「一番よい」を取り違える
    eval_matches: int = 40
    seed: int = 1
    device: str = "cuda" if torch.cuda.is_available() else "cpu"


def deep_config(cfg: TrainConfig) -> DeepConfig:
    return DeepConfig(
        hidden=cfg.hidden, layers=cfg.layers, iterations=cfg.iterations,
        traversals_per_iter=cfg.traversals_per_iter, adv_memory=cfg.adv_memory,
        strategy_memory=cfg.strategy_memory, adv_steps=cfg.adv_steps, adv_batch=cfg.adv_batch,
        adv_lr=cfg.adv_lr, strategy_steps=cfg.strategy_steps, strategy_batch=cfg.strategy_batch,
        strategy_lr=cfg.strategy_lr, min_stack_bb=cfg.min_stack_bb, max_stack_bb=cfg.max_stack_bb,
    )


# ---- ワーカー（別プロセスで木をたどる） ----


def _worker(args) -> dict:
    nets, player, traversals, seed, weight, cfg = args
    torch.set_num_threads(1)
    return collect(nets, player, traversals, seed, weight, cfg)


def _merge(chunks: list[dict]) -> dict:
    out: dict[str, np.ndarray] = {}
    for key in ("adv_x", "adv_y", "adv_mask", "adv_w", "str_x", "str_y", "str_mask", "str_w"):
        parts = [c[key] for c in chunks if len(c[key])]
        out[key] = np.concatenate(parts) if parts else np.zeros(0)
    return out


# ---- ネットの学習 ----


def _weighted(w: np.ndarray, device: str) -> torch.Tensor:
    """反復が進むほど重くする（linear CFR）。平均で割って学習率の意味を変えないようにする。"""
    t = torch.as_tensor(w, dtype=torch.float32, device=device)
    return t / t.mean().clamp(min=1e-6)


def train_advantage(memory: Reservoir, cfg: TrainConfig) -> PokerNet:
    """後悔を予想するネットを**まっさらから**学習する。

    毎回作り直すのは Deep CFR の作法。前の予想に引きずられると、間違いがそのまま
    積み上がっていくため。
    """
    device = cfg.device
    net = PokerNet(N_ACTIONS, cfg.hidden, cfg.layers).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=cfg.adv_lr)
    net.train()
    total = 0.0
    steps = max(1, min(cfg.adv_steps, len(memory) // 8 + 1))
    for _ in range(steps):
        x, y, mask, w = memory.sample(cfg.adv_batch)
        xb = torch.as_tensor(x, dtype=torch.float32, device=device)
        yb = torch.as_tensor(y, device=device)
        mb = torch.as_tensor(mask, device=device)
        wb = _weighted(w, device)
        pred = net(xb)
        loss = ((pred - yb) ** 2 * mb).sum(dim=1)
        loss = (loss * wb).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        total += float(loss.detach())
    net.eval()
    net.last_loss = total / steps  # type: ignore[attr-defined]
    return net


def train_strategy(memory: Reservoir, cfg: TrainConfig) -> PokerNet:
    """平均戦略を覚えるネット。**遊ぶのはこれ**。

    出力は打てる手の中でのソフトマックス。目標の確率との交差エントロピーを最小にする。
    """
    device = cfg.device
    net = PokerNet(N_ACTIONS, cfg.hidden, cfg.layers).to(device)
    opt = torch.optim.Adam(net.parameters(), lr=cfg.strategy_lr)
    net.train()
    total = 0.0
    steps = max(1, min(cfg.strategy_steps, len(memory) // 8 + 1))
    for _ in range(steps):
        x, y, mask, w = memory.sample(cfg.strategy_batch)
        xb = torch.as_tensor(x, dtype=torch.float32, device=device)
        yb = torch.as_tensor(y, device=device)
        mb = torch.as_tensor(mask, device=device)
        wb = _weighted(w, device)
        logits = net(xb).masked_fill(~mb, -1e9)
        logp = torch.log_softmax(logits, dim=1)
        loss = (-(yb * logp).sum(dim=1) * wb).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        total += float(loss.detach())
    net.eval()
    net.last_loss = total / steps  # type: ignore[attr-defined]
    return net


# ---- 学習の進行 ----


class Trainer:
    def __init__(self, cfg: TrainConfig, resume: bool = False):
        self.cfg = cfg
        self.dcfg = deep_config(cfg)
        self.dir = RUNS_DIR / cfg.run_name
        self.adv_memory = [
            Reservoir(cfg.adv_memory, N_FEATURES, N_ACTIONS, seed=cfg.seed + p) for p in (0, 1)
        ]
        self.str_memory = Reservoir(cfg.strategy_memory, N_FEATURES, N_ACTIONS, seed=cfg.seed + 7)
        self.nets = [zero_net(N_ACTIONS), zero_net(N_ACTIONS)]
        self.iteration = 0
        self.best = float("-inf")
        self.started = time.time()
        self.pool: mp.pool.Pool | None = None
        if resume:
            self._resume()

    def _resume(self) -> None:
        """advantage ネットだけ読み直す（メモリの中身は残していないので、貯め直しになる）。"""
        status = self._read_status()
        self.iteration = status.get("episode", 0)
        self.best = status.get("best") if status.get("best") is not None else float("-inf")
        for p in (0, 1):
            path = self.dir / "checkpoints" / f"advantage_{p}.pt"
            if path.exists():
                net, _ = PokerNet.load(path, "cpu")
                self.nets[p] = net.to_numpy()
        if self.iteration:
            print(f"{self.iteration} 反復目から続ける（メモリは貯め直し）")

    def _read_status(self) -> dict:
        try:
            return json.loads((self.dir / "status.json").read_text(encoding="utf-8"))
        except OSError:
            return {}

    def _status(self, state: str) -> None:
        write_json(self.dir / "status.json", {
            "run_name": self.cfg.run_name,
            "state": state,
            "episode": self.iteration,
            "episodes": self.cfg.iterations,
            "best": self.best if self.best != float("-inf") else None,
            "workers": self.cfg.workers,
            "elapsed_sec": round(time.time() - self.started, 1),
            "updated_at": now_iso(),
        })

    def _meta(self) -> dict:
        return {
            "iteration": self.iteration,
            "feature_version": FEATURE_VERSION,
            "traversals": self.iteration * self.cfg.traversals_per_iter * 2,
            "config": asdict(self.cfg),
        }

    def _collect(self, player: int, weight: float) -> dict:
        """木をたどって学習のもとを集める。"""
        nets = (self.nets[0], self.nets[1])
        total = self.cfg.traversals_per_iter
        if self.cfg.workers <= 0 or self.pool is None:
            return collect(nets, player, total, self.cfg.seed * 1000 + self.iteration * 2 + player,
                           weight, self.dcfg)
        n = self.cfg.workers
        chunk = max(1, total // n)
        args = [
            (nets, player, chunk, self.cfg.seed * 100_000 + self.iteration * 1000 + player * 50 + i,
             weight, self.dcfg)
            for i in range(n)
        ]
        return _merge(self.pool.map(_worker, args))

    def _store(self, data: dict, player: int) -> None:
        if len(data["adv_w"]):
            self.adv_memory[player].add(data["adv_x"], data["adv_y"], data["adv_mask"], data["adv_w"])
        if len(data["str_w"]):
            self.str_memory.add(data["str_x"], data["str_y"], data["str_mask"], data["str_w"])

    def _evaluate(self) -> None:
        """strategy ネットを作って強さを測り、よければ残す。"""
        t0 = time.time()
        strategy = train_strategy(self.str_memory, self.cfg)
        npnet = strategy.to_numpy()
        me = players.neural_player(npnet, seed=self.iteration)
        results: dict[str, dict] = {}
        mbbs: list[float] = []
        for name in ("random", "caller", "heuristic", "heuristic-loose"):
            r = evaluate.head_to_head(me, players.BASELINES[name](self.iteration),
                                      hands=self.cfg.eval_hands, seed=self.iteration + 1,
                                      start_stack=100 * BIG_BLIND)
            results[f"vs_{name}"] = r.as_dict()
            if name.startswith("heuristic"):
                mbbs.append(r.mbb_per_hand)  # 強さの判定は手強い相手だけで決める
        surv = evaluate.survival(me, players.BASELINES["heuristic"](self.iteration),
                                 matches=self.cfg.eval_matches, start_stack=100 * BIG_BLIND,
                                 max_hands=200, seed=self.iteration + 7)
        results["survival"] = surv.as_dict()

        # でたらめ相手の成績は青天井に伸びるので、「一番よい」の判定には使わない
        score = sum(mbbs) / max(1, len(mbbs))
        is_best = score > self.best
        ckpt = self.dir / "checkpoints"
        strategy.save(ckpt / "latest.pt", self._meta())
        if is_best:
            self.best = score
            strategy.save(ckpt / "best.pt", self._meta())
        if self.cfg.snapshot_every and self.iteration % self.cfg.snapshot_every == 0:
            # 世代として残す（強さだけでなく打ち方の「個性」を後から並べて比べられる）
            strategy.save(ckpt / f"iter_{self.iteration:06d}.pt", self._meta())
        append_jsonl(self.dir / "evals.jsonl", {
            "episode": self.iteration,
            "step": self.iteration,
            "checkpoint": "best.pt" if is_best else "latest.pt",
            "score": round(score, 1),
            "is_best": is_best,
            "results": results,
            "eval_sec": round(time.time() - t0, 1),
            "at": now_iso(),
        })
        shown = {k: v.get("mbb_per_hand", v.get("bust_rate")) for k, v in results.items()}
        print(f"  [評価] {self.iteration} 反復 score={score:.1f} mbb/hand (最良 {self.best:.1f}) {shown}")
        self._status("running")

    def train(self) -> None:
        write_json(self.dir / "config.json", asdict(self.cfg))
        print(f"run={self.cfg.run_name} 特徴量 {N_FEATURES} 次元 / 手の枠 {N_ACTIONS} / "
              f"{self.cfg.device} / ワーカー {self.cfg.workers}")
        if self.cfg.workers > 0:
            self.pool = mp.Pool(self.cfg.workers)
        state = "running"
        try:
            while self.iteration < self.cfg.iterations:
                self.iteration += 1
                weight = float(self.iteration)
                t0 = time.time()
                for player in (0, 1):
                    self._store(self._collect(player, weight), player)
                collected = time.time() - t0
                losses = []
                for player in (0, 1):
                    net = train_advantage(self.adv_memory[player], self.cfg)
                    self.nets[player] = net.to_numpy()
                    net.save(self.dir / "checkpoints" / f"advantage_{player}.pt", self._meta())
                    losses.append(net.last_loss)  # type: ignore[attr-defined]
                rate = self.cfg.traversals_per_iter * 2 / max(1e-9, collected)
                append_jsonl(self.dir / "metrics.jsonl", {
                    "episode": self.iteration,
                    "adv_loss": round(sum(losses) / 2, 4),
                    "adv_samples": len(self.adv_memory[0]),
                    "strategy_samples": len(self.str_memory),
                    "rate": round(rate, 1),
                    "collect_sec": round(collected, 1),
                    "at": now_iso(),
                })
                print(f"{self.iteration:5d} 反復  loss {sum(losses) / 2:8.3f}  "
                      f"貯めた数 {len(self.str_memory):,}  ({rate:.0f} 対局/秒)")
                self._status("running")
                if self.iteration % self.cfg.eval_every == 0:
                    self._evaluate()
            state = "finished"
        except KeyboardInterrupt:
            state = "stopped"
            print("中断しました（--resume で続けられます）")
        finally:
            if self.pool is not None:
                self.pool.close()
                self.pool.join()
        self._status(state)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    default = TrainConfig()
    for f in fields(default):
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(default, f.name)),
                        default=getattr(default, f.name))
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()
    cfg = TrainConfig(**{f.name: getattr(args, f.name) for f in fields(default)})
    Trainer(cfg, resume=args.resume).train()


if __name__ == "__main__":
    mp.freeze_support()
    main()
