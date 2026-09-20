"""強化学習（置いた後の局面の価値 V を学ぶ DQN 系の手法）。

実行例:
    python -m rl.tetris.train --run-name first                    # 既定: 6 プロセスで並列に遊ばせる
    python -m rl.tetris.train --run-name first --resume           # 続きから
    python -m rl.tetris.train --run-name dbg --workers 0          # 1 プロセスだけ（デバッガで追うとき）

出力（runs/<run_name>/）:
    config.json     使った設定
    metrics.jsonl   1 エピソード 1 行（消した列・火力・loss・epsilon など）
    evals.jsonl     評価 1 回 1 行（rl.tetris.evaluate の結果）
    status.json     いまの進み具合（強さページが読む）
    checkpoints/    ep_000250.pt, latest.pt, best.pt

学習の考え方:
    各手で「置いた後の局面」a を候補ごとに作り、score = 報酬 + gamma * V(a) が最大の手を選ぶ
    （確率 epsilon でランダム）。経験 (a_t, r_{t+1}, a_{t+1}, 終了か) を貯めて、
    V(a_t) ≒ r_{t+1} + gamma * V_target(a_{t+1}) となるようにネットの重みを更新する。

並列化（--workers N）:
    N 個の actor プロセスがそれぞれゲームを遊び、経験を Queue で learner（このプロセス）に送る。
    learner は GPU で学習し、定期的に共有メモリ上の重みを更新する。actor はエピソードの最初に
    その重みを読み込む。ゲームの処理（Python）が遅いので、CPU コア数に合わせて増やすと速くなる。
"""

from __future__ import annotations

import argparse
import json
import queue as queue_mod
import random
import time
from dataclasses import fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn

from .agent import HeuristicAgent, NeuralAgent, reward_of
from .config import RewardConfig, TrainConfig
from .encoding import FEATURE_DIM, FEATURE_NAMES, FEATURE_VERSION, encode_many
from .env import TetrisEnv, VersusEnv
from .evaluate import evaluate, strength_score
from .model import ValueNet, load_checkpoint, resolve_device, save_checkpoint
from ..common import runs_dir

RUNS_DIR = runs_dir("tetris")

# (a_t, r_{t+1}, a_{t+1}, done) を受け取る関数
TransitionSink = Callable[[np.ndarray, float, np.ndarray, bool], None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def schedule(start: float, end: float, episode: int, span: int) -> float:
    """episode が 0 → span で start → end に直線的に変わる値。"""
    frac = min(1.0, episode / max(1, span))
    return start + (end - start) * frac


def use_selfplay(cfg: TrainConfig, episode: int) -> bool:
    """このエピソードを自己対戦で遊ぶか（`selfplay_start` が負なら一度も使わない）。"""
    return 0 <= cfg.selfplay_start <= episode


def episode_params(cfg: TrainConfig, episode: int) -> tuple[float, float]:
    """(epsilon, おじゃまの量)"""
    return (
        schedule(cfg.eps_start, cfg.eps_end, episode, cfg.eps_decay_episodes),
        schedule(cfg.garbage_start, cfg.garbage_end, episode, cfg.garbage_ramp_episodes),
    )


def play_episode(
    env: TetrisEnv, model: ValueNet, cfg: TrainConfig, episode: int, device: torch.device,
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

    s = env.game.stats
    return {
        "episode": episode, "pieces": s.pieces, "lines": s.lines, "attack": s.attack,
        "tspin_clears": s.tspin_clears, "tetrises": s.tetrises, "max_combo": s.max_combo,
        "died": env.game.over, "reward": round(total_reward, 3),
        "epsilon": round(eps, 4), "garbage_rate": round(garbage, 4), "selfplay": False,
    }


def _require_current_features(meta: dict, what: str) -> None:
    """学習は最新の特徴量だけで行う（対局は古い重みでもできる。model.py 参照）。"""
    version = meta.get("feature_version", FEATURE_VERSION)
    if version != FEATURE_VERSION:
        raise SystemExit(
            f"{what} は特徴量バージョン {version} の重みです（今の学習は {FEATURE_VERSION}）。"
            f" 続きからは学習できません。新しい --run-name でゼロから学習してください。"
        )


def _winner(env: VersusEnv) -> int | None:
    """勝った側（0 / 1）。どちらも死んでいない・どちらも死んだなら None。"""
    over = [g.over for g in env.games]
    return None if over[0] == over[1] else (1 if over[0] else 0)


def play_versus_episode(
    env: VersusEnv, model: ValueNet, cfg: TrainConfig, episode: int, device: torch.device,
    sink: TransitionSink, on_step: Callable[[], None] | None = None,
) -> dict:
    """自己対戦を 1 局。**両方の側の経験を sink に流す**（1 局で 2 人分たまる）。

    どちらも同じ重みで打つ。相手が本物なので、届くおじゃまの量とタイミングが相手の盤面と
    つながっている（ランダムなおじゃまではここが切れていた）。
    記録するのは side 0 の成績。先に打つ側がわずかに有利なので、エピソードごとに順番を入れ替える。
    """
    eps, _ = episode_params(cfg, episode)
    env.reset(cfg.seed * 1_000_003 + episode, first=episode % 2)
    agent = NeuralAgent(model, cfg.gamma, cfg.reward, device)
    prev: list[np.ndarray | None] = [None, None]  # 側ごとに「前に置いた後の局面」を覚えておく
    reward_0 = 0.0

    while not env.done:
        side = env.turn
        cands = env.candidates(side)
        if not cands:
            env.games[side].over = True
            break
        feats = encode_many(cands)
        if random.random() < eps:
            idx = random.randrange(len(cands))
        else:
            idx = int(np.argmax(agent.scores(cands, feats)))
        c = cands[idx]
        r = reward_of(c, cfg.reward)
        if side == 0:
            reward_0 += r
        if prev[side] is not None:
            sink(prev[side], r, feats[idx], c.dead)
        prev[side] = feats[idx]
        env.step(side, c)
        if on_step:
            on_step()

    # 勝った側には終端の遷移が無い（相手は自分の手番で死ぬので、こちらの手とずれる）。
    # 「相手を倒した」を学ばせるには、ここで 1 つ流す必要がある。
    winner = _winner(env)
    if winner is not None and cfg.reward.win and prev[winner] is not None:
        sink(prev[winner], cfg.reward.win, prev[winner], True)
        if winner == 0:
            reward_0 += cfg.reward.win

    me, opp = env.games[0], env.games[1]
    s = me.stats
    return {
        "episode": episode, "pieces": s.pieces, "lines": s.lines, "attack": s.attack,
        "tspin_clears": s.tspin_clears, "tetrises": s.tetrises, "max_combo": s.max_combo,
        "died": me.over, "won": winner == 0, "reward": round(reward_0, 3),
        "epsilon": round(eps, 4), "selfplay": True,
        # 相手から実際に飛んできた火力（1 手あたり）。ランダムだった garbage_rate に対応する値
        "garbage_rate": round(opp.stats.attack / max(1, s.pieces), 4),
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
    env = TetrisEnv(cfg.max_pieces, 0.0, cfg.seed)
    versus = VersusEnv(cfg.max_pieces, cfg.seed)
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
        if use_selfplay(cfg, episode):
            row = play_versus_episode(versus, local, cfg, episode, device, sink)
        else:
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
        # best.pt の重みを固定したもの。評価のたびにこれと対戦し、勝ち越したら best.pt を差し替える
        self.best_agent: NeuralAgent | None = None
        self.last_loss: float | None = None
        if cfg.init_from:
            init, meta = load_checkpoint(Path(cfg.init_from), self.device)
            _require_current_features(meta, cfg.init_from)
            self.model.load_state_dict(init.state_dict())
            print(f"{cfg.init_from} の重みから始めます（エピソード数は 0 から）")
        if resume and (self.dir / "checkpoints" / "latest.pt").exists():
            model, meta = load_checkpoint(self.dir / "checkpoints" / "latest.pt", self.device)
            _require_current_features(meta, "latest.pt")
            self.model.load_state_dict(model.state_dict())
            self.episode, self.step = meta.get("episode", 0), meta.get("step", 0)
            self.best = meta.get("best", float("-inf"))
            print(f"resume from episode {self.episode}（リプレイバッファは空から）")
        if (self.dir / "checkpoints" / "best.pt").exists():
            best_model, best_meta = load_checkpoint(self.dir / "checkpoints" / "best.pt", self.device)
            _require_current_features(best_meta, "best.pt")
            self.best_agent = NeuralAgent(best_model, cfg.gamma, cfg.reward, self.device, name="best")
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
            "workers": self.cfg.workers, "elapsed_sec": round(time.time() - self._started, 1),
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
                f"ep {self.episode:6d} step {self.step:9d} lines {row['lines']:5d} atk {row['attack']:4d} "
                f"eps {row['epsilon']:.3f} loss {self.last_loss if self.last_loss is None else round(self.last_loss, 4)} "
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
        opponents: dict = {}
        if self.cfg.best_by == "versus":
            opponents["heuristic"] = HeuristicAgent()
            if self.best_agent is not None:
                opponents["best"] = self.best_agent
        res = evaluate(agent, self.cfg.eval_games, versus=opponents,
                       versus_games=self.cfg.versus_games, versus_max_pieces=self.cfg.versus_max_pieces)
        score = strength_score(res)
        is_best = self._promote_if_stronger(res, ckpt_dir, score)
        if is_best:
            self.best = score
        row = {
            "episode": self.episode, "step": self.step, "checkpoint": name, "score": score,
            "is_best": is_best, "results": res, "eval_sec": round(time.time() - t, 1), "at": _now(),
        }
        with open(self.dir / "evals.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        parts = [f"  [eval] ep={self.episode} score={score:.1f}"]
        for key in ("vs_heuristic", "vs_best"):
            if key in res:
                parts.append(f"{key.replace('vs_', 'vs ')}={res[key]['win_rate']:.0%}")
        parts.append(f"solo lines={res.get('solo', {}).get('avg_lines', 0):.1f}")
        parts.append(f"pressure attack={res.get('pressure', {}).get('avg_attack', 0):.1f}")
        print(" ".join(parts) + (" → best 更新" if is_best else ""))

    def _promote_if_stronger(self, res: dict, ckpt_dir: Path, score: float) -> bool:
        """best.pt を差し替えるかどうか。`best_by` で選び方が変わる。

        "versus"（既定）: 今の best.pt と対戦して勝ち越していたら差し替える。勝った方が次の相手に
            なるので、相手も一緒に強くなっていく。「火力の平均が過去最高なら best」という選び方だと、
            打ち切りの手数で頭打ちになったあとは運で決まってしまうため。
        "solo": ひとり遊びの成績（火力中心）が過去最高なら差し替える。対戦は測らないので評価が速い。
            火力を伸ばすことだけを狙ったモデルを作るときに使う。
        """
        if self.cfg.best_by == "solo":
            if score <= self.best:
                return False
        elif self.best_agent is not None and res["vs_best"]["win_rate"] < self.cfg.promote_win_rate:
            return False
        save_checkpoint(ckpt_dir / "best.pt", self.model, self._meta())
        frozen = ValueNet(FEATURE_DIM, self.cfg.hidden, self.cfg.layers).to(self.device)
        frozen.load_state_dict(self.model.state_dict())
        self.best_agent = NeuralAgent(frozen, self.cfg.gamma, self.cfg.reward, self.device, name="best")
        return True

    # --- 実行 -----------------------------------------------------------------
    def train(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "config.json").write_text(json.dumps(self.cfg.to_dict(), indent=2), encoding="utf-8")
        print(f"run={self.cfg.run_name} device={self.device} workers={self.cfg.workers} features={FEATURE_DIM}")
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
        env = TetrisEnv(self.cfg.max_pieces, 0.0, self.cfg.seed)
        versus = VersusEnv(self.cfg.max_pieces, self.cfg.seed)
        while self.episode < self.cfg.episodes:
            self.model.eval()
            ep = self.episode + 1
            if use_selfplay(self.cfg, ep):
                row = play_versus_episode(versus, self.model, self.cfg, ep, self.device, self.add_transition)
            else:
                row = play_episode(env, self.model, self.cfg, ep, self.device, self.add_transition)
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
    for f in fields(TrainConfig):
        if f.name == "reward":
            continue
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(defaults, f.name)),
                        default=getattr(defaults, f.name))
    for f in fields(RewardConfig):
        ap.add_argument(f"--reward-{f.name}", type=float, default=getattr(RewardConfig(), f.name))
    ap.add_argument("--resume", action="store_true", help="runs/<run_name>/checkpoints/latest.pt から続ける")
    args = vars(ap.parse_args())
    resume = args.pop("resume")
    reward = RewardConfig(**{f.name: args.pop(f"reward_{f.name}") for f in fields(RewardConfig)})
    return TrainConfig(**args, reward=reward), resume


def main() -> None:
    cfg, resume = _parse_args()
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    Trainer(cfg, resume).train()


if __name__ == "__main__":
    main()
