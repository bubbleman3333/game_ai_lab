"""手を選ぶ AI。学習済みネットを使う NeuralAgent と、比較用の HeuristicAgent がある。

どちらも choose(Position) -> Candidate | None を持つ（Agent プロトコル）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

import numpy as np
import torch

from games.tetris.features import board_features

from .config import RewardConfig
from .encoding import encode_many
from .model import ValueNet, load_checkpoint
from .position import Candidate, Position, enumerate_candidates


def reward_of(c: Candidate, cfg: RewardConfig) -> float:
    if c.dead:
        return cfg.death
    return cfg.alive + cfg.line * c.outcome.lines + cfg.attack * c.outcome.attack


class Agent(Protocol):
    name: str

    def choose(self, pos: Position) -> Candidate | None: ...


class NeuralAgent:
    """score = 報酬 + gamma * V(置いた後) が最大の手を選ぶ。"""

    def __init__(self, model: ValueNet, gamma: float, reward: RewardConfig, device="cpu", name="neural"):
        self.model = model.to(device).eval()
        self.gamma = gamma
        self.reward = reward
        self.device = torch.device(device)
        self.name = name
        self.episode: int | None = None  # 何エピソード目まで学習した重みか

    @classmethod
    def load(cls, path: Path, device="cpu") -> "NeuralAgent":
        model, meta = load_checkpoint(path, device)
        cfg = meta.get("config", {})
        reward = RewardConfig(**cfg.get("reward", {}))
        agent = cls(model, cfg.get("gamma", 0.97), reward, device, name=Path(path).stem)
        agent.episode = meta.get("episode")
        return agent

    @torch.no_grad()
    def scores(self, cands: list[Candidate], feats: np.ndarray | None = None) -> np.ndarray:
        if feats is None:
            feats = encode_many(cands)
        v = self.model(torch.from_numpy(feats).to(self.device)).cpu().numpy()
        r = np.array([reward_of(c, self.reward) for c in cands], dtype=np.float32)
        alive = np.array([not c.dead for c in cands], dtype=np.float32)
        return r + self.gamma * v * alive

    def choose(self, pos: Position) -> Candidate | None:
        cands = enumerate_candidates(pos)
        if not cands:
            return None
        return cands[int(np.argmax(self.scores(cands)))]


class HeuristicAgent:
    """重み固定の評価関数（GA で調整するタイプの AI と同じ形）。強さ比較の基準に使う。"""

    WEIGHTS = {"agg_height": -0.51, "holes": -3.6, "bumpiness": -0.18, "lines": 0.76, "attack": 1.0}

    def __init__(self, name: str = "heuristic"):
        self.name = name

    def _score(self, c: Candidate) -> float:
        if c.dead:
            return -1e9
        f = board_features(c.outcome.board)
        w = self.WEIGHTS
        return (
            w["agg_height"] * f.agg_height + w["holes"] * f.holes + w["bumpiness"] * f.bumpiness
            + w["lines"] * c.outcome.lines + w["attack"] * c.outcome.attack
        )

    def choose(self, pos: Position) -> Candidate | None:
        cands = enumerate_candidates(pos)
        return max(cands, key=self._score) if cands else None
