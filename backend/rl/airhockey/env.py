"""学習用の環境。N 面のエアホッケーを同時に進める。学習する AI は常にプレイヤー 0（手前）。

相手（プレイヤー 1）は面ごとに決める:
    - 過去の自分（学習途中で保存したスナップショット）… 自己対戦で互いに強くなる
    - 学習なしの AI（速さをランダムに変える）… 基本的な守り・攻めの相手
1 点入るか、時間切れで 1 エピソードが終わり、その面だけ自動で初期配置に戻る。
"""

from __future__ import annotations

import numpy as np
import torch

from games.airhockey import physics as P

from .policy import ActorCritic

FRAME_SKIP = 2  # AI は 2 ステップ（1/30 秒）ごとに行動を決める
MAX_SECONDS = 15.0
SHAPING = 0.01  # パックを相手側へ運ぶと少しだけ報酬（得点 ±1 に比べてずっと小さい）
HEURISTIC = -1  # 相手の種類: 学習なしの AI


class SelfPlayEnv:
    def __init__(self, n: int, seed: int = 0, heuristic_prob: float = 0.3):
        self.n = n
        self.rng = np.random.default_rng(seed)
        self.s = P.State.zeros(n)
        self.t = np.zeros(n, dtype=np.int64)
        self.opp = np.full(n, HEURISTIC)  # 面ごとの相手（スナップショット番号 or HEURISTIC）
        self.opp_speed = np.ones(n)
        self.snapshots: list[ActorCritic] = []
        self.heuristic_prob = heuristic_prob
        self._reset(np.ones(n, dtype=bool))

    def add_snapshot(self, model: ActorCritic, keep: int = 10) -> None:
        snap = ActorCritic(model.hidden)
        snap.load_state_dict({k: v.detach().cpu() for k, v in model.state_dict().items()})
        snap.eval()
        self.snapshots.append(snap)
        if len(self.snapshots) > keep:
            self.snapshots.pop(0)

    def _reset(self, mask: np.ndarray) -> None:
        P.reset(self.s, mask, self.rng.integers(0, 2, self.n), self.rng)
        self.t[mask] = 0
        k = int(mask.sum())
        if not k:
            return
        use_h = self.rng.random(k) < self.heuristic_prob
        opp = np.full(k, HEURISTIC)
        if self.snapshots:
            # 新しいスナップショットほど選ばれやすくする
            weights = np.arange(1, len(self.snapshots) + 1, dtype=float)
            picks = self.rng.choice(len(self.snapshots), size=k, p=weights / weights.sum())
            opp = np.where(use_h, HEURISTIC, picks)
        self.opp[mask] = opp
        self.opp_speed[mask] = self.rng.uniform(0.6, 1.0, k)

    def observe(self) -> np.ndarray:
        return P.observe(self.s, 0)

    def _opponent_action(self) -> tuple[np.ndarray, np.ndarray]:
        hx, hy = P.heuristic_action(self.s, 1)
        hx, hy = hx * self.opp_speed, hy * self.opp_speed
        vx, vy = hx.copy(), hy.copy()
        if self.snapshots:
            obs1 = torch.from_numpy(P.observe(self.s, 1))
            for i in np.unique(self.opp[self.opp != HEURISTIC]):
                idx = np.nonzero(self.opp == i)[0]
                a = self.snapshots[int(i)].act(obs1[idx]).numpy().astype(np.float64)
                wx, wy = P.action_to_world(a[:, 0], a[:, 1], 1)
                vx[idx], vy[idx] = wx, wy
        return vx, vy

    def step(self, action: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """action: (N, 2)、-1〜1。戻り値: (次の観測, 報酬, 終わったか, 得点 +1/-1/0)"""
        a0x, a0y = P.action_to_world(action[:, 0].astype(np.float64), action[:, 1].astype(np.float64), 0)
        o1x, o1y = self._opponent_action()
        goal = np.zeros(self.n)
        for _ in range(FRAME_SKIP):
            g = P.step(self.s, a0x, a0y, o1x, o1y)
            goal = np.where(goal == 0, g, goal)
        self.t += FRAME_SKIP
        timeout = self.t * P.DT >= MAX_SECONDS
        done = (goal != 0) | timeout
        reward = goal + SHAPING * (self.s.pvy / P.PUCK_VMAX) * (goal == 0)
        self._reset(done)
        return self.observe(), reward.astype(np.float32), done, goal


def play_points(policy, opponent: str, points: int, seed: int = 0, n: int = 64) -> dict:
    """評価用: 決まった相手と points 点ぶん打ち合う（方策は平均の行動を使う）。

    opponent: "heuristic" / "heuristic-slow"（速さ 70%）
    """
    rng = np.random.default_rng(seed)
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), rng.integers(0, 2, n), rng)
    t = np.zeros(n, dtype=np.int64)
    won = lost = draws = 0
    speed = 0.7 if opponent == "heuristic-slow" else 1.0
    while won + lost + draws < points:
        obs = torch.from_numpy(P.observe(s, 0))
        a = policy.act(obs, deterministic=True).numpy().astype(np.float64)
        a0x, a0y = P.action_to_world(a[:, 0], a[:, 1], 0)
        goal = np.zeros(n)
        for _ in range(FRAME_SKIP):
            hx, hy = P.heuristic_action(s, 1, speed)
            g = P.step(s, a0x, a0y, hx, hy)
            goal = np.where(goal == 0, g, goal)
        t += FRAME_SKIP
        timeout = (t * P.DT >= MAX_SECONDS) & (goal == 0)
        won += int((goal > 0).sum())
        lost += int((goal < 0).sum())
        draws += int(timeout.sum())
        done = (goal != 0) | timeout
        P.reset(s, done, rng.integers(0, 2, n), rng)
        t[done] = 0
    decided = max(1, won + lost)
    return {"points": won + lost + draws, "won": won, "lost": lost, "timeouts": draws, "win_rate": won / decided}
