"""オセロの評価関数（n-tuple ネットワーク）を自己対戦と TD 学習で育てる。

実行例:
    python -m rl.othello.train --run-name v1                 # 既定: 6 プロセスで並列に自己対戦
    python -m rl.othello.train --run-name v1 --resume        # 続きから
    python -m rl.othello.train --run-name dbg --workers 0    # 1 プロセスだけ（デバッガで追うとき）

学習の考え方（テトリスと同じ TD 学習）:
    V(局面) = 「手番側から見た最終石差 / 64」の予想。
    1 手ごとに、全部の合法手について「打った後の局面の価値」を計算し（1 手読み）、
    一番よい手の価値を目標にして V(今の局面) を近づける:
        V(s) ← V(s) + lr × (max_手 価値(打った後) − V(s))
    終局した手は実際の石差がそのまま目標になるので、正しい情報が終局から序盤へ伝わっていく。
    先手も後手も同じ評価関数で打つ（自己対戦）。

並列化:
    重みの表を共有メモリに置き、各プロセスが同時に書き換える（Hogwild! と呼ばれる方法）。
    パターンごとに触る重みがばらばらなので、ぶつかってもほとんど問題にならない。

出力（runs/othello/<run_name>/）は テトリスと同じ形:
    config.json / metrics.jsonl（1 局 1 行）/ evals.jsonl / status.json / checkpoints/*.npz
"""

from __future__ import annotations

import argparse
import queue as queue_mod
import random
import time
from dataclasses import asdict, dataclass, fields
from multiprocessing import get_context, shared_memory

import numpy as np

from games.othello.board import Position, bits

from ..common import append_jsonl, now_iso, runs_dir, write_json
from .evaluate import evaluate, strength_score
from .ntuple import N_STAGES, TABLE_SIZE, NTupleNet
from .players import child_values

RUNS_DIR = runs_dir("othello")


@dataclass
class TrainConfig:
    run_name: str = "default"
    games: int = 300_000
    lr: float = 0.05  # 1 回の更新で誤差の何割を埋めるか
    lr_end: float = 0.01  # 最後にはここまで下げる
    eps_start: float = 0.10  # ランダムに打つ確率
    eps_end: float = 0.02
    random_opening: int = 2  # 最初の何手をランダムにするか（序盤をばらけさせる）
    workers: int = 6
    checkpoint_every: int = 10_000  # 何局ごとに保存・評価するか
    seed: int = 0


def _schedule(start: float, end: float, done: int, total: int) -> float:
    return start + (end - start) * min(1.0, done / max(1, total))


def self_play_game(net: NTupleNet, cfg: TrainConfig, game_no: int, rng: random.Random) -> dict:
    """1 局自己対戦しながら学習する。戻り値は metrics.jsonl の 1 行。"""
    lr = _schedule(cfg.lr, cfg.lr_end, game_no, cfg.games)
    eps = _schedule(cfg.eps_start, cfg.eps_end, game_no, cfg.games)
    pos = Position.initial()
    errors: list[float] = []
    ply = 0
    while not pos.is_over():
        moves, values = child_values(net, pos)
        best = max(range(len(moves)), key=values.__getitem__)
        # 学習: 今の局面の価値を「一番よい手を打った後の価値」に近づける
        err = values[best] - net.evaluate(pos)
        net.update(pos, lr * err)
        errors.append(abs(err))
        # 打つ手: 序盤と確率 eps でランダム（いろいろな局面を経験するため）
        if ply < cfg.random_opening or rng.random() < eps:
            sq = rng.choice(moves)
        else:
            sq = moves[best]
        pos = pos.play(sq).normalize()
        ply += 1
    score = pos.final_score()
    black_diff = score if pos.black_to_move else -score
    return {
        "episode": game_no, "moves": ply, "black_disc_diff": black_diff,
        "abs_black_disc_diff": abs(black_diff), "td_error": float(np.mean(errors)) if errors else 0.0,
        "lr": round(lr, 5), "epsilon": round(eps, 4),
    }


# --- 並列（子プロセス） -----------------------------------------------------------


def _worker(worker_id: int, cfg_dict: dict, shm_name: str, counter, out_q, stop) -> None:
    cfg = TrainConfig(**cfg_dict)
    shm = shared_memory.SharedMemory(name=shm_name)
    try:
        w = np.ndarray((N_STAGES, TABLE_SIZE), dtype=np.float32, buffer=shm.buf)
        net = NTupleNet(w)  # 共有メモリの表をそのまま読み書きする
        rng = random.Random(cfg.seed * 7919 + worker_id)
        while not stop.is_set():
            with counter.get_lock():
                counter.value += 1
                game_no = counter.value
            if game_no > cfg.games:
                break
            out_q.put(self_play_game(net, cfg, game_no, rng))
    finally:
        del net, w
        shm.close()
        out_q.put(None)


class Trainer:
    def __init__(self, cfg: TrainConfig, resume: bool):
        self.cfg = cfg
        self.dir = RUNS_DIR / cfg.run_name
        self.done = 0
        self.best = float("-inf")
        self.started = time.time()
        self.init_w = np.zeros((N_STAGES, TABLE_SIZE), dtype=np.float32)
        latest = self.dir / "checkpoints" / "latest.npz"
        if resume and latest.exists():
            self.init_w = NTupleNet.load(latest).w
            meta = self._read_status()
            self.done = meta.get("episode", 0)
            self.best = meta.get("best") if meta.get("best") is not None else float("-inf")
            print(f"resume from game {self.done}")

    def _read_status(self) -> dict:
        import json

        try:
            return json.loads((self.dir / "status.json").read_text(encoding="utf-8"))
        except OSError:
            return {}

    def _status(self, state: str) -> None:
        write_json(self.dir / "status.json", {
            "run_name": self.cfg.run_name, "state": state, "episode": self.done, "episodes": self.cfg.games,
            "best": self.best if self.best != float("-inf") else None, "workers": self.cfg.workers, "elapsed_sec": round(time.time() - self.started, 1),
            "updated_at": now_iso(),
        })

    def _checkpoint(self, net: NTupleNet) -> None:
        snap = NTupleNet(net.w.copy())
        ckpt = self.dir / "checkpoints"
        name = f"game_{self.done:07d}.npz"
        meta = {"episode": self.done, "config": asdict(self.cfg)}
        snap.save(ckpt / name, meta)
        snap.save(ckpt / "latest.npz", meta)
        t = time.time()
        res = evaluate(snap)
        score = strength_score(res)
        is_best = score > self.best
        if is_best:
            self.best = score
            snap.save(ckpt / "best.npz", meta)
        append_jsonl(self.dir / "evals.jsonl", {
            "episode": self.done, "step": self.done, "checkpoint": name, "score": score, "is_best": is_best,
            "results": res, "eval_sec": round(time.time() - t, 1), "at": now_iso(),
        })
        wr = {k: f"{v['win_rate']:.0%}" for k, v in res.items()}
        print(f"  [eval] game={self.done} score={score:.3f} (best {self.best:.3f}) 勝率 {wr}")
        self._status("running")

    def _on_game(self, row: dict, net: NTupleNet) -> None:
        self.done += 1
        row["at"] = now_iso()
        append_jsonl(self.dir / "metrics.jsonl", row)
        if self.done % 1000 == 0:
            rate = self.done / max(1e-9, time.time() - self.started)
            print(f"game {self.done:8d}  td_error {row['td_error']:.4f}  eps {row['epsilon']:.3f}  ({rate:.0f} 局/秒)")
            self._status("running")
        if self.done % self.cfg.checkpoint_every == 0:
            self._checkpoint(net)

    def train(self) -> None:
        write_json(self.dir / "config.json", asdict(self.cfg))
        print(f"run={self.cfg.run_name} workers={self.cfg.workers} 重みの数={N_STAGES * TABLE_SIZE:,}")
        state = "running"
        try:
            if self.cfg.workers <= 0:
                self._train_single()
            else:
                self._train_parallel()
            state = "finished"
        except KeyboardInterrupt:
            state = "stopped"
            print("中断しました")
        self._status(state)

    def _train_single(self) -> None:
        net = NTupleNet(self.init_w)
        rng = random.Random(self.cfg.seed)
        while self.done < self.cfg.games:
            self._on_game(self_play_game(net, self.cfg, self.done + 1, rng), net)
        NTupleNet(net.w.copy()).save(self.dir / "checkpoints" / "latest.npz", {"episode": self.done})

    def _train_parallel(self) -> None:
        ctx = get_context("spawn")
        shm = shared_memory.SharedMemory(create=True, size=self.init_w.nbytes)
        w = np.ndarray(self.init_w.shape, dtype=np.float32, buffer=shm.buf)
        w[:] = self.init_w
        net = NTupleNet(w)
        counter = ctx.Value("i", self.done)
        out_q = ctx.Queue(maxsize=10_000)
        stop = ctx.Event()
        procs = [
            ctx.Process(target=_worker, args=(i, asdict(self.cfg), shm.name, counter, out_q, stop), daemon=True)
            for i in range(self.cfg.workers)
        ]
        for p in procs:
            p.start()
        alive = len(procs)
        try:
            while alive:
                try:
                    row = out_q.get(timeout=1.0)
                except queue_mod.Empty:
                    if not any(p.is_alive() for p in procs):
                        break
                    continue
                if row is None:
                    alive -= 1
                else:
                    self._on_game(row, net)
        finally:
            stop.set()
            NTupleNet(w.copy()).save(self.dir / "checkpoints" / "latest.npz", {"episode": self.done})
            for p in procs:
                p.join(timeout=5)
                if p.is_alive():
                    p.terminate()
            del net, w
            shm.close()
            shm.unlink()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    d = TrainConfig()
    for f in fields(TrainConfig):
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(d, f.name)), default=getattr(d, f.name))
    ap.add_argument("--resume", action="store_true")
    args = vars(ap.parse_args())
    resume = args.pop("resume")
    cfg = TrainConfig(**args)
    random.seed(cfg.seed)
    Trainer(cfg, resume).train()


if __name__ == "__main__":
    main()
