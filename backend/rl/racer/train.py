"""レース AI を PPO（強化学習）で鍛える。

実行例:
    python -m rl.racer.train --run-name v1
    python -m rl.racer.train --run-name v1 --resume
    python -m rl.racer.train --run-name dbg --iterations 20 --envs 64   # 動作確認

学習の流れ
----------
1. **模倣学習**（`--bc-steps`）: 学習なしの運転者（`games/racer/physics.py` の heuristic_action。
   先の中心線へ向けてステアを切り、コーナーの手前で減速する）の動きをまねる。
   「とりあえずコースに沿って走る」を先に覚えさせる。ゼロから試行錯誤させると、
   壁にぶつかって止まるばかりで、いつまでも 1 周できない。
2. **PPO**: 256 面を同時に走らせて経験を集める。報酬は「前へ進んだ距離」が中心で、
   壁に当たると減点、コースから落ちると大きく減点、空中で半回転して着地すると加点。
   まねただけでは通らない攻めたライン取りや、ジャンプ台での飛び方を自分で見つけていく。

レースには対戦相手がいないので、自己対戦（過去の自分と戦わせる仕組み）は要らない。
そのぶんエアホッケーより学習は素直で速い。

3 つのコースと 3 つの車を混ぜて学習させるので、1 つの方策でどれでも走れるようになる。

出力（runs/racer/<run_name>/）はほかのゲームと同じ形:
    config.json / metrics.jsonl（1 イテレーション 1 行）/ evals.jsonl / status.json
    checkpoints/latest.pt, best.pt と、ブラウザ用の latest.json, best.json
"""

from __future__ import annotations

import argparse
import time
from dataclasses import asdict, dataclass, fields

import numpy as np
import torch
from torch import nn

from games.racer import physics as P

from ..common import append_jsonl, now_iso, runs_dir, write_json
from .env import RaceEnv, evaluate
from .policy import ACT_DIM, ActorCritic, export_json, load, save

RUNS_DIR = runs_dir("racer")


@dataclass
class TrainConfig:
    run_name: str = "default"
    iterations: int = 1500
    envs: int = 256
    steps: int = 128  # 1 イテレーションで各面を何ステップ進めるか
    epochs: int = 4
    minibatch: int = 4096
    lr: float = 3e-4
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip: float = 0.2
    entropy: float = 0.004
    value_coef: float = 0.5
    hidden: int = 256
    eval_every: int = 25
    eval_laps: int = 1
    bc_steps: int = 4000  # 最初に学習なしの運転者をまねさせる回数（0 ならしない）
    bc_noise: float = 0.25  # まねのデータを集めるとき、動きに混ぜるばらつき
    seed: int = 0


class Trainer:
    def __init__(self, cfg: TrainConfig, resume: bool):
        self.cfg = cfg
        self.dir = RUNS_DIR / cfg.run_name
        torch.manual_seed(cfg.seed)
        self.model = ActorCritic(cfg.hidden)
        self.opt = torch.optim.Adam(self.model.parameters(), lr=cfg.lr)
        self.it = 0
        self.best = -1.0
        self.started = time.time()
        latest = self.dir / "checkpoints" / "latest.pt"
        if resume and latest.exists():
            model, meta = load(latest)
            self.model.load_state_dict(model.state_dict())
            self.it, self.best = meta.get("episode", 0), meta.get("best", -1.0)
            print(f"resume from iteration {self.it}")
        self.env = RaceEnv(cfg.envs, cfg.seed)
        if not self.it and cfg.bc_steps:
            self.behavior_clone()

    # --- 模倣学習 -------------------------------------------------------------
    def behavior_clone(self) -> None:
        """学習なしの運転者の操作を正解として、方策の平均を合わせる（回帰）。"""
        c, env = self.cfg, self.env
        rng = np.random.default_rng(c.seed)
        print(f"模倣学習: 学習なしの運転者の操作を {c.bc_steps} 回まねます")
        opt = torch.optim.Adam(self.model.actor.parameters(), lr=1e-3)
        for k in range(1, c.bc_steps + 1):
            obs = env.observe()
            target = np.zeros((env.n, ACT_DIM))
            for course, car, idx in env.slices():
                th, st, jp = P.heuristic_action(env.sub(idx), car, course)
                target[idx, 0], target[idx, 1], target[idx, 2] = th, st, jp
            pred = self.model.actor(torch.from_numpy(obs))
            loss = (pred - torch.from_numpy(target.astype(np.float32))).pow(2).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            # 少しばらつかせた操作で環境を進め、いろいろな状況を集める
            act = np.clip(target + rng.normal(0, c.bc_noise, target.shape), -1, 1)
            env.step(act.astype(np.float32))
            if k % 500 == 0:
                print(f"  bc {k}/{c.bc_steps}  loss {float(loss.detach()):.4f}", flush=True)
        with torch.no_grad():
            self.model.log_std.fill_(-1.0)  # まねた動きの近くを探すよう、ばらつきを小さめにする

    # --- 1 イテレーション ------------------------------------------------------
    def collect(self) -> dict:
        c, env = self.cfg, self.env
        T, N = c.steps, c.envs
        obs_buf = np.zeros((T, N, P.OBS_DIM), np.float32)
        act_buf = np.zeros((T, N, ACT_DIM), np.float32)
        logp_buf = np.zeros((T, N), np.float32)
        rew_buf = np.zeros((T, N), np.float32)
        done_buf = np.zeros((T, N), np.float32)
        val_buf = np.zeros((T + 1, N), np.float32)
        obs = env.observe()
        total = {"progress": 0.0, "falls": 0.0, "tricks": 0.0, "hits": 0.0, "speed": 0.0}
        self.model.eval()
        with torch.no_grad():
            for t in range(T):
                o = torch.from_numpy(obs)
                d = self.model.dist(o)
                a = d.sample()
                obs_buf[t], act_buf[t] = obs, a.numpy()
                logp_buf[t] = d.log_prob(a).sum(-1).numpy()
                val_buf[t] = self.model.value(o).numpy()
                obs, r, done, info = env.step(a.clamp(-1, 1).numpy())
                rew_buf[t], done_buf[t] = r, done
                total["progress"] += float(info["gained"].sum())
                total["falls"] += float(info["falls"].sum())
                total["tricks"] += float(info["tricks"].sum())
                total["hits"] += float(info["hits"].sum())
            val_buf[T] = self.model.value(torch.from_numpy(obs)).numpy()

        # GAE: 「予想より良かった度合い」を後ろから積み上げる
        adv = np.zeros((T, N), np.float32)
        last = np.zeros(N, np.float32)
        for t in reversed(range(T)):
            nonterm = 1.0 - done_buf[t]
            delta = rew_buf[t] + c.gamma * val_buf[t + 1] * nonterm - val_buf[t]
            last = delta + c.gamma * c.gae_lambda * nonterm * last
            adv[t] = last
        ret = adv + val_buf[:T]
        self.batch = {
            "obs": torch.from_numpy(obs_buf.reshape(T * N, P.OBS_DIM)),
            "act": torch.from_numpy(act_buf.reshape(T * N, ACT_DIM)),
            "logp": torch.from_numpy(logp_buf.reshape(-1)),
            "adv": torch.from_numpy(adv.reshape(-1)),
            "ret": torch.from_numpy(ret.reshape(-1)),
        }
        seconds = T * P.DT * 2  # 1 面あたりの秒数（FRAME_SKIP = 2）
        return {
            "progress": total["progress"] / N,  # 1 面あたりに進んだ距離（m）
            "speed": total["progress"] / N / seconds,  # 平均の速さ（m/s）
            "falls": total["falls"] / N,
            "tricks": total["tricks"] / N,
            "hit_rate": total["hits"] / (T * N),
            "reward": float(rew_buf.sum()) / N,
        }

    def update(self) -> dict:
        c, b = self.cfg, self.batch
        n = b["obs"].shape[0]
        adv = (b["adv"] - b["adv"].mean()) / (b["adv"].std() + 1e-8)
        self.model.train()
        stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}
        count = 0
        for _ in range(c.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, c.minibatch):
                idx = perm[i : i + c.minibatch]
                d = self.model.dist(b["obs"][idx])
                logp = d.log_prob(b["act"][idx]).sum(-1)
                ratio = (logp - b["logp"][idx]).exp()
                a = adv[idx]
                policy_loss = -torch.min(ratio * a, ratio.clamp(1 - c.clip, 1 + c.clip) * a).mean()
                value_loss = (self.model.value(b["obs"][idx]) - b["ret"][idx]).pow(2).mean()
                entropy = d.entropy().sum(-1).mean()
                loss = policy_loss + c.value_coef * value_loss - c.entropy * entropy
                self.opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.model.parameters(), 0.5)
                self.opt.step()
                stats["policy_loss"] += float(policy_loss.detach())
                stats["value_loss"] += float(value_loss.detach())
                stats["entropy"] += float(entropy.detach())
                count += 1
        return {k: v / count for k, v in stats.items()} | {
            "action_std": float(self.model.log_std.detach().exp().mean())}

    # --- 保存・評価 ---------------------------------------------------------
    def _meta(self) -> dict:
        return {"episode": self.it, "best": self.best, "config": asdict(self.cfg), "saved_at": now_iso()}

    def checkpoint_and_eval(self) -> None:
        ckpt = self.dir / "checkpoints"
        save(self.model, ckpt / "latest.pt", self._meta())
        export_json(self.model, ckpt / "latest.json", self._meta())
        self.model.eval()
        t = time.time()
        out = evaluate(self.model, laps=self.cfg.eval_laps, seed=1)
        score, res = out["score"], out["results"]
        is_best = score > self.best
        if is_best:
            self.best = score
            save(self.model, ckpt / "best.pt", self._meta())
            export_json(self.model, ckpt / "best.json", self._meta())
        append_jsonl(self.dir / "evals.jsonl", {
            "episode": self.it, "step": self.it, "checkpoint": f"iter_{self.it:06d}", "score": score,
            "is_best": is_best, "results": res, "eval_sec": round(time.time() - t, 1), "at": now_iso(),
        })
        laps = "  ".join(f"{k} {v['lap_sec']:.1f}s（学習なし {v['heuristic_sec']:.1f}s）"
                         for k, v in res.items())
        print(f"  [eval] iter={self.it} 速さの比 {score:.2f}  {laps}")

    def _status(self, state: str) -> None:
        write_json(self.dir / "status.json", {
            "run_name": self.cfg.run_name, "state": state, "episode": self.it,
            "episodes": self.cfg.iterations, "best": self.best,
            "elapsed_sec": round(time.time() - self.started, 1), "updated_at": now_iso(),
        })

    def train(self) -> None:
        write_json(self.dir / "config.json", asdict(self.cfg))
        print(f"run={self.cfg.run_name} envs={self.cfg.envs} steps={self.cfg.steps}")
        state = "running"
        try:
            while self.it < self.cfg.iterations:
                t0 = time.time()
                roll = self.collect()
                upd = self.update()
                self.it += 1
                sps = self.cfg.envs * self.cfg.steps / (time.time() - t0)
                append_jsonl(self.dir / "metrics.jsonl", {
                    "episode": self.it, "step": self.it * self.cfg.envs * self.cfg.steps,
                    **roll, **upd, "steps_per_sec": round(sps), "at": now_iso()})
                if self.it % 10 == 0:
                    print(f"iter {self.it:5d}  進んだ距離 {roll['progress']:6.0f}m  "
                          f"落下 {roll['falls']:.2f}  トリック {roll['tricks']:.2f}  "
                          f"std {upd['action_std']:.2f}  {sps:,.0f} steps/s", flush=True)
                    self._status(state)
                if self.it % self.cfg.eval_every == 0:
                    self.checkpoint_and_eval()
            state = "finished"
        except KeyboardInterrupt:
            state = "stopped"
        save(self.model, self.dir / "checkpoints" / "latest.pt", self._meta())
        export_json(self.model, self.dir / "checkpoints" / "latest.json", self._meta())
        self._status(state)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    d = TrainConfig()
    for f in fields(TrainConfig):
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(d, f.name)),
                        default=getattr(d, f.name))
    ap.add_argument("--resume", action="store_true")
    args = vars(ap.parse_args())
    resume = args.pop("resume")
    torch.set_num_threads(4)
    Trainer(TrainConfig(**args), resume).train()


if __name__ == "__main__":
    main()
