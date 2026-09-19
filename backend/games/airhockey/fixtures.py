"""TypeScript 版の物理・観測・学習なし AI・方策の計算が Python 版と一致するか確かめるテストデータ。

実行: cd backend; python -m games.airhockey.fixtures
出力: shared/fixtures/airhockey/engine_cases.json
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import physics as P

OUT = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "airhockey" / "engine_cases.json"


def _state_dict(s: P.State, i: int) -> dict:
    return {f: float(getattr(s, f)[i]) for f in P.FIELDS}


def build() -> dict:
    import torch

    from rl.airhockey.policy import ActorCritic

    rng = np.random.default_rng(3)
    n = 4
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), np.array([0, 1, 0, 1]))
    initial = [_state_dict(s, i) for i in range(n)]
    steps = []
    for t in range(240):
        # プレイヤー 0 はランダム、プレイヤー 1 は学習なし AI（衝突や壁の反射がたくさん起きるように）
        a0x = rng.uniform(-5, 5, n)
        a0y = rng.uniform(-5, 5, n)
        h1x, h1y = P.heuristic_action(s, 1)
        goal = P.step(s, a0x, a0y, h1x, h1y)
        steps.append({
            "a0": [[float(a0x[i]), float(a0y[i])] for i in range(n)],
            "h1": [[float(h1x[i]), float(h1y[i])] for i in range(n)],
            "goal": [float(g) for g in goal],
            "state": [_state_dict(s, i) for i in range(n)],
            "obs1": P.observe(s, 1).astype(float).tolist(),
        })
        done = goal != 0
        if done.any():
            P.reset(s, done, np.zeros(n, dtype=int))

    # 方策（MLP）の計算の一致: 乱数の重みで作ったネットの出力
    torch.manual_seed(0)
    model = ActorCritic(hidden=16)
    obs = torch.from_numpy(P.observe(s, 0))
    layers = [m for m in model.actor if isinstance(m, torch.nn.Linear)]
    policy = {
        "layers": [{"w": l.weight.detach().tolist(), "b": l.bias.detach().tolist()} for l in layers],
        "obs": obs.tolist(),
        "action": model.act(obs, deterministic=True).tolist(),
    }
    return {"initial": initial, "steps": steps, "policy": policy}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build()), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
