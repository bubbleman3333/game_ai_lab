"""TypeScript 版の計算が Python 版と一致するか確かめるテストデータ。

実行: cd backend; python -m games.racer.fixtures
出力: shared/fixtures/racer/engine_cases.json

中身:
    courses  コースの組み立て（曲線 → 1m ごとの点）の結果。飛び飛びに抜き出した点を比べる
    cars     車の性能の読み込み
    runs     実際に走らせた記録。ジャンプ台・落下と復帰・砂・加速パネル・壁当たり・
             空中で回ってからの着地（トリック）を全部通す
    policy   方策（MLP）の計算

記録する数値は小数 9 桁で丸めてある（ファイルを小さくするため）。
車に与える入力もあらかじめ丸めた値を使うので、TypeScript 側は同じ入力で同じ結果になる。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import course as CO
from . import physics as P

OUT = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "racer" / "engine_cases.json"

STEPS = 360  # 6 秒ぶん
STATE_EVERY = 3  # 状態は何ステップおきに記録するか
OBS_EVERY = 20  # 観測は何ステップおきに記録するか
ROUND = 9


def _r(v) -> float:
    return round(float(v), ROUND)


def _state_dict(s: P.State, i: int) -> dict:
    return {f: _r(getattr(s, f)[i]) for f in P.FIELDS}


def _course_case(cid: str) -> dict:
    """コースの組み立ての結果。点を 37 個おきに抜き出して比べる。"""
    c = CO.load(cid)
    return {
        "id": c.id, "n": c.n, "spacing": _r(c.spacing), "length": _r(c.length), "laps": c.laps,
        "samples": [{
            "i": i, "x": _r(c.x[i]), "y": _r(c.y[i]), "z": _r(c.z[i]),
            "width": _r(c.width[i]), "bank": _r(c.bank[i]), "heading": _r(c.heading[i]),
            "kind": int(c.kind[i]), "safe": int(c.safe[i]),
        } for i in range(0, c.n, 37)],
    }


def _run(course_id: str, car_id: str, start: list[int], lane: list[float], speed: list[float],
         drivers: list[str], seed: int) -> dict:
    """1 本ぶんの走行記録。

    drivers は車ごとの動かし方:
        heuristic  学習なしの運転者（まともに走る）
        slow       学習なしの運転者の弱い版（速度が足りず、途切れた道に落ちる）
        random     でたらめ（壁に当たる・スピンする・変な着地をする）
        spin       全開のままステアを切り続ける（空中で回ってトリックを決める）
    """
    c = CO.load(course_id)
    car = P.load_car(car_id)
    n = len(start)
    rng = np.random.default_rng(seed)
    s = P.State.zeros(n)
    P.reset(s, np.ones(n, dtype=bool), c, np.array(start), np.array(lane), np.array(speed))
    initial = [_state_dict(s, i) for i in range(n)]

    steps = []
    for t in range(STEPS):
        hf = P.heuristic_action(s, car, c)  # 学習なしの運転者（全員ぶん計算して記録する）
        hs = P.heuristic_action(s, car, c, skill=0.5)
        th, st = np.zeros(n), np.zeros(n)
        jp = np.full(n, -1.0)
        for i, d in enumerate(drivers):
            if d == "heuristic":
                th[i], st[i], jp[i] = hf[0][i], hf[1][i], hf[2][i]
            elif d == "slow":
                th[i], st[i], jp[i] = hs[0][i], hs[1][i], hs[2][i]
            elif d == "spin":
                # 地面では全開でジャンプ台へ向かい、飛んだら目いっぱい回す。
                # 自分で跳ぶ（jump）と滞空が短くて 1 回転できないので、ここでは使わない
                in_air = s.on_ground[i] < 0.5
                th[i] = 1.0
                st[i] = 1.0 if in_air else hf[1][i]
                jp[i] = -1.0
            else:  # random
                th[i] = round(rng.uniform(-0.4, 1.0), 6)
                st[i] = round(rng.uniform(-1.0, 1.0), 6)
                jp[i] = round(rng.uniform(-1.0, 1.0), 6)
        ev = P.step(s, car, c, th, st, jp)
        row: dict = {
            "in": [[_r(th[i]), _r(st[i]), _r(jp[i])] for i in range(n)],
            "heur": [[_r(hf[0][i]), _r(hf[1][i]), _r(hf[2][i])] for i in range(n)],
            "heur_slow": [[_r(hs[0][i]), _r(hs[1][i]), _r(hs[2][i])] for i in range(n)],
            "ev": {k: [int(v[i]) if k != "tricks" else int(v[i]) for i in range(n)]
                   for k, v in ev.items()},
        }
        if t % STATE_EVERY == 0:
            row["state"] = [_state_dict(s, i) for i in range(n)]
        if t % OBS_EVERY == 0:
            row["obs"] = [[_r(v) for v in row_] for row_ in P.observe(s, car, c).tolist()]
        steps.append(row)
    return {"course": course_id, "car": car_id, "start": start, "lane": lane, "speed": speed,
            "drivers": drivers, "initial": initial, "steps": steps}


def build() -> dict:
    import torch

    from rl.racer.policy import ActorCritic

    desert = CO.load("desert")
    # 道が途切れている区間の手前から走らせる（飛び越える車と、落ちて戻される車の両方を通す）
    gap = int(np.argmax(desert.kind == CO.KIND_GAP))
    ramp = (gap - 100) % desert.n

    runs = [
        # ジャンプ台 → 途切れた道。飛び越える / 落ちる / でたらめ / 回る の 4 台。
        # 落ちる車は速度が足りないので、ジャンプ台の近くから始めて確実に途切れた道まで届かせる
        _run("desert", "balanced", [ramp, (gap - 45) % desert.n, ramp, ramp],
             [0.0, 4.0, -4.0, 7.0], [40.0, 16.0, 35.0, 42.0],
             ["heuristic", "slow", "random", "spin"], 1),
        # 砂の区間と丘のジャンプ台。回る車はジャンプ台の直前から全開で入らせて、
        # 空中で 1 回転して着地する（トリック）ところまで確実に通す
        _run("meadow", "speed", [0, 380, 600], [0.0, 3.0, 0.0], [30.0, 40.0, 50.0],
             ["heuristic", "random", "spin"], 2),
        # バンクのきつい高架と切り返し。1 台はゴール線の手前から走らせて、周回の数え方も通す
        _run("neon", "grip", [CO.load("neon").n - 120, 260, 285], [0.0, 3.0, 0.0], [25.0, 38.0, 45.0],
             ["heuristic", "random", "spin"], 3),
    ]

    # 方策（MLP）の計算の一致: 乱数の重みで作ったネットの出力
    torch.manual_seed(0)
    model = ActorCritic(hidden=16)
    s = P.State.zeros(4)
    P.reset(s, np.ones(4, dtype=bool), desert, np.array([0, 200, 600, 900]),
            np.array([0.0, 2.0, -2.0, 4.0]), np.array([10.0, 30.0, 0.0, 45.0]))
    obs = torch.from_numpy(P.observe(s, P.load_car("balanced"), desert))
    layers = [m for m in model.actor if isinstance(m, torch.nn.Linear)]
    policy = {
        "layers": [{"w": l.weight.detach().tolist(), "b": l.bias.detach().tolist()} for l in layers],
        "obs": [[_r(v) for v in row] for row in obs.tolist()],
        "action": [[_r(v) for v in row] for row in model.act(obs, deterministic=True).tolist()],
    }

    return {
        "courses": [_course_case(cid) for cid in CO.course_ids()],
        "cars": [{k: v for k, v in P.load_car(cid).__dict__.items()} for cid in P.car_ids()],
        "runs": runs,
        "policy": policy,
    }


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build()), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
