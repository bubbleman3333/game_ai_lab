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
from .encoding import FEATURE_VERSION, encode_many
from .model import ValueNet, load_checkpoint
from .position import Candidate, Position, enumerate_candidates, position_after


def reward_of(c: Candidate, cfg: RewardConfig) -> float:
    if c.dead:
        return cfg.death
    return cfg.alive + cfg.line * c.outcome.lines + cfg.attack * c.outcome.attack


class Agent(Protocol):
    name: str

    def choose(self, pos: Position) -> Candidate | None: ...


class NeuralAgent:
    """score = 報酬 + gamma * V(置いた後) が最大の手を選ぶ。

    lookahead=n にすると NEXT のミノを n 個先まで読む（ビームサーチ。_beam_search）。
    例えば lookahead=1 は「今のミノ + NEXT 1 個」の 2 手で比べる。
    学習（train.py）は 1 手だけで行い、先読みは対局（API・評価）のときだけ使う。
    """

    def __init__(self, model: ValueNet, gamma: float, reward: RewardConfig, device="cpu", name="neural",
                 lookahead: int = 0, beam: int = 8, feature_version: int = FEATURE_VERSION):
        self.model = model.to(device).eval()
        # この重みがどの特徴量で学習されたか。古い重みは古いエンコーダで読む（model.py 参照）
        self.feature_version = feature_version
        self.gamma = gamma
        self.reward = reward
        self.device = torch.device(device)
        self.name = name
        self.episode: int | None = None  # 何エピソード目まで学習した重みか
        self.lookahead = lookahead
        self.beam = beam

    @classmethod
    def load(cls, path: Path, device="cpu", lookahead: int = 0, beam: int = 8) -> "NeuralAgent":
        model, meta = load_checkpoint(path, device)
        cfg = meta.get("config", {})
        reward = RewardConfig(**cfg.get("reward", {}))
        agent = cls(model, cfg.get("gamma", 0.97), reward, device, name=Path(path).stem,
                    lookahead=lookahead, beam=beam,
                    feature_version=meta.get("feature_version", FEATURE_VERSION))
        agent.episode = meta.get("episode")
        return agent

    @torch.no_grad()
    def scores(self, cands: list[Candidate], feats: np.ndarray | None = None) -> np.ndarray:
        if feats is None:
            feats = encode_many(cands, self.feature_version)
        v = self.model(torch.from_numpy(feats).to(self.device)).cpu().numpy()
        r = np.array([reward_of(c, self.reward) for c in cands], dtype=np.float32)
        alive = np.array([not c.dead for c in cands], dtype=np.float32)
        return r + self.gamma * v * alive

    def choose(self, pos: Position) -> Candidate | None:
        cands = enumerate_candidates(pos)
        if not cands:
            return None
        s1 = self.scores(cands)
        if self.lookahead <= 0:
            return cands[int(np.argmax(s1))]
        return cands[self._beam_search(cands, s1)]

    def _beam_search(self, cands: list[Candidate], s1: np.ndarray) -> int:
        """lookahead 手先まで NEXT を使って読み、一番よい 1 手目の番号を返す（ビームサーチ）。

        各段で点数の高い beam 個の局面だけを次の段に進める。局面の点数は
            ここまでの報酬（割引あり）+ gamma^深さ * V(最後に置いた後)
        読み終えた局面（最後の段・死ぬ手・NEXT が分からない）の中で点数が最大のものの 1 手目を選ぶ。
        """
        g = self.gamma
        # 局面: (点数, 1 手目の番号, 最後の手, ここまでの報酬, 次の段の割引)
        nodes = [(float(s1[i]), i, c, reward_of(c, self.reward), g) for i, c in enumerate(cands)]
        finished = [n for n in nodes if n[2].dead]
        frontier = sorted((n for n in nodes if not n[2].dead), key=lambda n: -n[0])[: self.beam]
        for _ in range(self.lookahead):
            expand: list[tuple] = []
            children: list[list[Candidate]] = []
            for n in frontier:
                nxt = position_after(n[2])
                if nxt is None:
                    finished.append(n)  # NEXT が分からないので、ここで読み終える
                    continue
                cs = enumerate_candidates(nxt)
                if not cs:
                    finished.append((n[3] + n[4] * self.reward.death, n[1], n[2], n[3], n[4]))
                    continue
                expand.append(n)
                children.append(cs)
            if not expand:
                frontier = []
                break
            flat = [c for cs in children for c in cs]
            sc = self.scores(flat)
            nxt_nodes = []
            k = 0
            for n, cs in zip(expand, children):
                _, root, _, acc, disc = n
                for c in cs:
                    nxt_nodes.append((acc + disc * float(sc[k]), root, c, acc + disc * reward_of(c, self.reward), disc * g))
                    k += 1
            finished.extend(n for n in nxt_nodes if n[2].dead)
            frontier = sorted((n for n in nxt_nodes if not n[2].dead), key=lambda n: -n[0])[: self.beam]
        best = max(frontier + finished, key=lambda n: n[0])
        return best[1]


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
