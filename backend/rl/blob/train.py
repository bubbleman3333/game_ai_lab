"""強化学習（置いた後の盤面の価値 V を学ぶ DQN 系の手法）。テトリスの rl/tetris/train.py と同じ作り。

実行例:
    python -m rl.blob.train --run-name first                    # 既定: 6 プロセスで並列に遊ばせる
    python -m rl.blob.train --run-name first --resume           # 続きから
    python -m rl.blob.train --run-name dbg --workers 0          # 1 プロセスだけ（デバッガで追うとき）

出力（runs/blob/<run_name>/）:
    config.json     使った設定
    metrics.jsonl   1 エピソード 1 行（送ったおじゃま・最大連鎖・loss・epsilon など）
    evals.jsonl     評価 1 回 1 行（rl.blob.evaluate の結果）
    status.json     いまの進み具合（強さページが読む）
    checkpoints/    ep_000250.pt, latest.pt, best.pt

学習の考え方:
    各手で「置いた後の盤面」a を候補（最大 24 通り）ごとに作り、score = 報酬 + gamma * V(a)
    が最大の手を選ぶ（確率 epsilon でランダム）。経験 (a_t, r_{t+1}, a_{t+1}, 終了か) を貯めて、
    V(a_t) ≒ r_{t+1} + gamma * V_target(a_{t+1}) となるようにネットの重みを更新する。
    連鎖は 10 手以上かけて組むので、gamma はテトリスより大きめ（0.98）にしてある。
"""

from __future__ import annotations

import argparse
import json
import queue as queue_mod
import random
import time
from dataclasses import fields, replace
from datetime import datetime, timezone
from typing import Callable

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn

from .agent import NeuralAgent, reward_of
from .config import REWARD_PRESETS, STYLE_DEFAULTS, RewardConfig, TrainConfig
from .encoding import FEATURE_DIM, FEATURE_NAMES, encode_many
from .env import BlobEnv
from .evaluate import BIG_CHAIN, evaluate, strength_score
from .model import ValueNet, load_checkpoint, resolve_device, save_checkpoint
from ..common import runs_dir

RUNS_DIR = runs_dir("blob")

# (a_t, r_{t+1}, a_{t+1}, done) を受け取る関数
TransitionSink = Callable[[np.ndarray, float, np.ndarray, bool], None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def schedule(start: float, end: float, episode: int, span: int) -> float:
    """episode が 0 → span で start → end に直線的に変わる値。"""
    frac = min(1.0, episode / max(1, span))
    return start + (end - start) * frac


def episode_params(cfg: TrainConfig, episode: int) -> tuple[float, float]:
    """(epsilon, おじゃまの量)"""
    return (
        schedule(cfg.eps_start, cfg.eps_end, episode, cfg.eps_decay_episodes),
        schedule(cfg.garbage_start, cfg.garbage_end, episode, cfg.garbage_ramp_episodes),
    )


def play_episode(
    env: BlobEnv, model: ValueNet, cfg: TrainConfig, episode: int, device: torch.device,
    sink: TransitionSink, on_step: Callable[[], None] | None = None,
) -> dict:
    """1 ゲーム遊んで経験を sink に流す。戻り値は metrics.jsonl の 1 行。"""
    eps, garbage = episode_params(cfg, episode)
    env.garbage_rate = garbage
    env.reset(cfg.seed * 1_000_003 + episode)
    agent = NeuralAgent(model, cfg.gamma, cfg.reward, device)
    prev: np.ndarray | None = None
    total_reward = 0.0

    while not env.done:
        cands = env.candidates()
        if not cands:
            break
        feats = encode_many(cands)
        if random.random() < eps:
            idx = random.randrange(len(cands))
        else:
            idx = int(np.argmax(agent.scores(cands, feats)))
        c = cands[idx]
        r = reward_of(c, cfg.reward)
        total_reward += r
        if prev is not None:
            sink(prev, r, feats[idx], c.dead)
        prev = feats[idx]
        env.step(c)
        if on_step:
            on_step()

    g = env.game
    chains = env.chain_stats(BIG_CHAIN)
    return {
        "episode": episode, "pairs": g.stats.pairs, "sent": g.stats.sent, "score": g.score,
        "max_chain": g.max_chain, "all_clears": g.stats.all_clears,
        "avg_fire_chain": round(chains["avg_fire_chain"], 2), "big_chains": chains["big_chains"],
        "small_fires": chains["small_fires"],
        "died": g.over, "reward": round(total_reward, 3),
        "epsilon": round(eps, 4), "garbage_rate": round(garbage, 4),
    }


class ReplayBuffer:
    def __init__(self, size: int):
        self.size = size
        self.s = np.zeros((size, FEATURE_DIM), np.float32)
        self.s2 = np.zeros((size, FEATURE_DIM), np.float32)
        self.r = np.zeros(size, np.float32)
        self.done = np.zeros(size, np.float32)
        self.n = 0
        self.i = 0

    def add(self, s: np.ndarray, r: float, s2: np.ndarray, done: bool) -> None:
        self.s[self.i], self.r[self.i], self.s2[self.i], self.done[self.i] = s, r, s2, done
        self.i = (self.i + 1) % self.size
        self.n = min(self.n + 1, self.size)

    def add_batch(self, s: np.ndarray, r: np.ndarray, s2: np.ndarray, done: np.ndarray) -> None:
        for k in range(len(r)):
            self.add(s[k], float(r[k]), s2[k], bool(done[k]))

    def sample(self, k: int, device: torch.device):
        idx = np.random.randint(0, self.n, size=k)
        t = lambda a: torch.from_numpy(a[idx]).to(device)  # noqa: E731
        return t(self.s), t(self.r), t(self.s2), t(self.done)


# --- actor（並列時の子プロセス） ------------------------------------------------------


def _actor_main(worker_id: int, cfg_dict: dict, shared: ValueNet, counter, out_q, stop) -> None:
    torch.set_num_threads(1)
    cfg = TrainConfig.from_dict(cfg_dict)
    random.seed(cfg.seed * 7919 + worker_id)
    np.random.seed((cfg.seed * 7919 + worker_id) % 2**32)
    device = torch.device("cpu")
    local = ValueNet(FEATURE_DIM, cfg.hidden, cfg.layers)
    env = BlobEnv(cfg.max_pairs, 0.0, cfg.seed)
    chunk: list[tuple] = []

    def flush() -> None:
        if chunk:
            s, r, s2, d = zip(*chunk)
            out_q.put(("tr", np.stack(s), np.array(r, np.float32), np.stack(s2), np.array(d, np.float32)))
            chunk.clear()

    def sink(s, r, s2, d) -> None:
        chunk.append((s, r, s2, d))
        if len(chunk) >= 256:
            flush()

    while not stop.is_set():
        with counter.get_lock():
            counter.value += 1
            episode = counter.value
        if episode > cfg.episodes:
            break
        local.load_state_dict(shared.state_dict())
        local.eval()
        row = play_episode(env, local, cfg, episode, device, sink)
        flush()
        out_q.put(("ep", row))
    out_q.put(("exit", worker_id))


# --- learner --------------------------------------------------------------------


class Trainer:
    def __init__(self, cfg: TrainConfig, resume: bool = False):
        self.cfg = cfg
        self.dir = RUNS_DIR / cfg.run_name
        self.device = resolve_device(cfg.device)
        self.model = ValueNet(FEATURE_DIM, cfg.hidden, cfg.layers).to(self.device)
        self.target = ValueNet(FEATURE_DIM, cfg.hidden, cfg.layers).to(self.device)
        self.opt = torch.optim.Adam(self.model.parameters(), lr=cfg.lr)
        self.buffer = ReplayBuffer(cfg.buffer_size)
        self.episode = 0  # 終わったエピソード数
        self.step = 0  # 受け取った経験の数
        self.updates = 0
        self.best = float("-inf")
        self.last_loss: float | None = None
        if resume and (self.dir / "checkpoints" / "latest.pt").exists():
            model, meta = load_checkpoint(self.dir / "checkpoints" / "latest.pt", self.device)
            self.model.load_state_dict(model.state_dict())
            self.episode, self.step = meta.get("episode", 0), meta.get("step", 0)
            self.best = meta.get("best", float("-inf"))
            print(f"resume from episode {self.episode}（リプレイバッファは空から）")
            saved = meta.get("config", {}).get("reward_preset")
            if saved and saved != cfg.reward_preset:
                # スタイルを途中で変えると、それまでに学んだ「よい盤面」の基準が食い違う
                print(f"  !! この run は style={saved} で学習していました（今回の指定は {cfg.reward_preset}）。"
                      f"続きから学習するなら --reward-preset {saved} を付けてください")
        self.target.load_state_dict(self.model.state_dict())
        self._pending_updates = 0.0
        self._started = time.time()

    # --- 学習 -----------------------------------------------------------------
    def add_transition(self, s, r, s2, done) -> None:
        self.buffer.add(s, r, s2, done)
        self._after_transitions(1)

    def _after_transitions(self, n: int) -> None:
        self.step += n
        if self.buffer.n < self.cfg.learn_start:
            return
        self._pending_updates += n / self.cfg.learn_every
        while self._pending_updates >= 1:
            self._pending_updates -= 1
            self.last_loss = self.learn()

    def learn(self) -> float:
        self.model.train()
        s, r, s2, done = self.buffer.sample(self.cfg.batch_size, self.device)
        with torch.no_grad():
            target = r + self.cfg.gamma * self.target(s2) * (1 - done)
        loss = nn.functional.smooth_l1_loss(self.model(s), target)
        self.opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.model.parameters(), 10.0)
        self.opt.step()
        self.updates += 1
        if self.updates % self.cfg.target_sync == 0:
            self.target.load_state_dict(self.model.state_dict())
        return float(loss.item())

    # --- 記録・保存・評価 -----------------------------------------------------------
    def _meta(self) -> dict:
        return {
            "config": self.cfg.to_dict(), "episode": self.episode, "step": self.step,
            "best": self.best, "feature_names": FEATURE_NAMES, "saved_at": _now(),
        }

    def _write_status(self, state: str) -> None:
        status = {
            "run_name": self.cfg.run_name, "state": state, "episode": self.episode,
            "episodes": self.cfg.episodes, "step": self.step, "updates": self.updates,
            "workers": self.cfg.workers, "reward_preset": self.cfg.reward_preset,
            "elapsed_sec": round(time.time() - self._started, 1),
            "device": str(self.device), "updated_at": _now(),
        }
        (self.dir / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")

    def _on_episode(self, row: dict, log) -> None:
        self.episode += 1
        row.update(step=self.step, loss=self.last_loss, at=_now())
        log.write(json.dumps(row) + "\n")
        log.flush()
        if self.episode % 10 == 0:
            print(
                f"ep {self.episode:6d} step {self.step:9d} pairs {row['pairs']:4d} sent {row['sent']:5d} "
                f"chain {row['max_chain']:2d} avg {row['avg_fire_chain']:4.1f} big {row['big_chains']:2d} "
                f"eps {row['epsilon']:.3f} "
                f"loss {self.last_loss if self.last_loss is None else round(self.last_loss, 4)} "
                f"({time.time() - self._started:.0f}s)"
            )
            self._write_status("running")
        if self.episode % self.cfg.checkpoint_every == 0:
            self.checkpoint_and_eval()

    def checkpoint_and_eval(self) -> None:
        ckpt_dir = self.dir / "checkpoints"
        name = f"ep_{self.episode:06d}.pt"
        save_checkpoint(ckpt_dir / name, self.model, self._meta())
        save_checkpoint(ckpt_dir / "latest.pt", self.model, self._meta())
        if not self.cfg.eval_every or self.episode % self.cfg.eval_every:
            return
        agent = NeuralAgent(self.model, self.cfg.gamma, self.cfg.reward, self.device)
        t = time.time()
        res = evaluate(agent, self.cfg.eval_games)
        score = strength_score(res, self.cfg.reward_preset)
        is_best = score > self.best
        if is_best:
            self.best = score
            save_checkpoint(ckpt_dir / "best.pt", self.model, self._meta())
        row = {
            "episode": self.episode, "step": self.step, "checkpoint": name, "score": score,
            "is_best": is_best, "results": res, "eval_sec": round(time.time() - t, 1), "at": _now(),
        }
        with open(self.dir / "evals.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        solo, pressure = res.get("solo", {}), res.get("pressure", {})
        print(
            f"  [eval] ep={self.episode} score={score:.2f} (best {self.best:.2f}) "
            f"solo chain={solo.get('avg_max_chain', 0):.1f} avg={solo.get('avg_fire_chain', 0):.1f} "
            f"big={solo.get('big_chains_per_game', 0):.1f} "
            f"pressure chain={pressure.get('avg_max_chain', 0):.1f} survival={pressure.get('survival_rate', 0):.0%}"
        )

    # --- 実行 -----------------------------------------------------------------
    def train(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "config.json").write_text(json.dumps(self.cfg.to_dict(), indent=2), encoding="utf-8")
        print(f"run={self.cfg.run_name} style={self.cfg.reward_preset} device={self.device} "
              f"workers={self.cfg.workers} features={FEATURE_DIM}")
        state = "running"
        try:
            with open(self.dir / "metrics.jsonl", "a", encoding="utf-8") as log:
                if self.cfg.workers <= 0:
                    self._train_single(log)
                else:
                    self._train_parallel(log)
            state = "finished"
        except KeyboardInterrupt:
            state = "stopped"
            print("中断しました。latest.pt を保存します")
        save_checkpoint(self.dir / "checkpoints" / "latest.pt", self.model, self._meta())
        self._write_status(state)

    def _train_single(self, log) -> None:
        env = BlobEnv(self.cfg.max_pairs, 0.0, self.cfg.seed)
        while self.episode < self.cfg.episodes:
            self.model.eval()
            row = play_episode(env, self.model, self.cfg, self.episode + 1, self.device, self.add_transition)
            self._on_episode(row, log)

    def _train_parallel(self, log) -> None:
        ctx = mp.get_context("spawn")
        shared = ValueNet(FEATURE_DIM, self.cfg.hidden, self.cfg.layers)
        shared.load_state_dict({k: v.cpu() for k, v in self.model.state_dict().items()})
        shared.share_memory()
        counter = ctx.Value("i", self.episode)
        out_q = ctx.Queue(maxsize=512)
        stop = ctx.Event()
        procs = [
            ctx.Process(target=_actor_main, args=(i, self.cfg.to_dict(), shared, counter, out_q, stop), daemon=True)
            for i in range(self.cfg.workers)
        ]
        for p in procs:
            p.start()
        alive = len(procs)
        last_sync = 0
        try:
            while alive > 0:
                try:
                    msg = out_q.get(timeout=1.0)
                except queue_mod.Empty:
                    if not any(p.is_alive() for p in procs):
                        break
                    continue
                kind = msg[0]
                if kind == "tr":
                    _, s, r, s2, d = msg
                    self.buffer.add_batch(s, r, s2, d)
                    self._after_transitions(len(r))
                    if self.updates - last_sync >= self.cfg.weight_sync:
                        with torch.no_grad():
                            for p_sh, p_m in zip(shared.parameters(), self.model.parameters()):
                                p_sh.copy_(p_m.detach().cpu())
                        last_sync = self.updates
                elif kind == "ep":
                    self._on_episode(msg[1], log)
                elif kind == "exit":
                    alive -= 1
        finally:
            stop.set()
            # 残りのメッセージを捨てて子プロセスが終われるようにする
            deadline = time.time() + 5
            while time.time() < deadline and any(p.is_alive() for p in procs):
                try:
                    out_q.get(timeout=0.2)
                except queue_mod.Empty:
                    pass
            for p in procs:
                if p.is_alive():
                    p.terminate()


def _parse_args() -> tuple[TrainConfig, bool]:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    defaults = TrainConfig()
    # すべて「指定されたときだけ」効くようにする（既定値はスタイルごとに後から埋める）
    for f in fields(TrainConfig):
        if f.name in ("reward", "reward_preset"):
            continue
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(defaults, f.name)),
                        default=argparse.SUPPRESS, help=f"既定 {getattr(defaults, f.name)}")
    ap.add_argument("--reward-preset", default=defaults.reward_preset, choices=tuple(REWARD_PRESETS),
                    help="AI のスタイル（chain = 連鎖オンリー、versus = 対戦に勝つ）")
    for f in fields(RewardConfig):
        ap.add_argument(f"--reward-{f.name}", type=type(getattr(RewardConfig(), f.name)),
                        default=argparse.SUPPRESS, help="（既定はスタイルの値）")
    ap.add_argument("--resume", action="store_true", help="runs/blob/<run_name>/checkpoints/latest.pt から続ける")
    args = vars(ap.parse_args())
    resume = args.pop("resume")
    style = args.pop("reward_preset")
    overrides = {f.name: args.pop(f"reward_{f.name}") for f in fields(RewardConfig) if f"reward_{f.name}" in args}
    # 優先順位: コマンドラインで指定した値 > スタイルごとの既定 > TrainConfig の既定
    cfg = TrainConfig(reward_preset=style, **{**STYLE_DEFAULTS.get(style, {}), **args},
                      reward=replace(REWARD_PRESETS[style], **overrides))
    return cfg, resume


def main() -> None:
    cfg, resume = _parse_args()
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    Trainer(cfg, resume).train()


if __name__ == "__main__":
    main()
