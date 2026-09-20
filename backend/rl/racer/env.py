"""学習用の環境。N 台のレースカーを同時に走らせる。

エアホッケーやオセロと違って、レースには「相手」がいない（速く走れば勝ち）。
だから自己対戦は要らず、報酬は「コースをどれだけ前へ進めたか」が中心になる。
そのぶん学習は素直で速い。

面ごとに、コースも車も開始位置もばらばらにする:
    - 3 つのコースを混ぜて学習させるので、1 つの方策でどのコースも走れるようになる
    - 開始位置をコース全体にばらまくので、後半のコーナーも均等に経験できる
      （毎回スタート地点からだと、最初のコーナーばかり練習することになる）
    - 開始速度もばらばらにするので、止まった状態からの発進も高速での進入も覚える

1 エピソードは MAX_SECONDS 秒。進まなくなった面は早めに打ち切って入れ替える。
"""

from __future__ import annotations

import numpy as np
import torch

from games.racer import course as CO
from games.racer import physics as P

FRAME_SKIP = 2  # AI は 2 ステップ（1/30 秒）ごとに行動を決める
MAX_SECONDS = 22.0
STUCK_SECONDS = 3.0  # この時間ぜんぜん進まなかったら打ち切る
STUCK_DISTANCE = 6.0

# 報酬の重み
R_PROGRESS = 1.0  # 1m 進むごと
R_FALL = -40.0  # コースから落ちた
R_HIT = -0.25  # 壁に当たった 1 ステップごと
R_TRICK = 6.0  # 空中で半回転して着地した
R_BACKWARD = 2.0  # 後ろへ下がったときの追加の罰（前進の重みに上乗せ）


class RaceEnv:
    """N 面を同時に進める。面ごとにコースと車が違う。"""

    def __init__(self, n: int, seed: int = 0, course_ids: list[str] | None = None,
                 car_ids: list[str] | None = None):
        self.n = n
        self.rng = np.random.default_rng(seed)
        self.course_ids = course_ids or CO.course_ids()
        self.car_ids = car_ids or P.car_ids()
        self.courses = [CO.load(c) for c in self.course_ids]
        self.cars = [P.load_car(c) for c in self.car_ids]
        # 面をコースごと・車ごとのまとまりに分ける（まとめて numpy で計算するため）
        self.group = self.rng.integers(0, len(self.courses) * len(self.cars), n)
        self.s = P.State.zeros(n)
        self.t = np.zeros(n)
        self.since_check = np.zeros(n)
        self.check_prog = np.zeros(n)
        self.reset(np.ones(n, dtype=bool))

    # --- 面のまとまり ---------------------------------------------------------
    def slices(self):
        """(コース, 車, その面の番号の配列) を順に返す。"""
        for g in np.unique(self.group):
            idx = np.nonzero(self.group == g)[0]
            yield self.courses[g // len(self.cars)], self.cars[g % len(self.cars)], idx

    def sub(self, idx: np.ndarray) -> P.State:
        """一部の面だけを取り出した State（配列の見た目だけ切り出す）。"""
        return P.State(*(getattr(self.s, f)[idx] for f in P.FIELDS))

    def write(self, sub: P.State, idx: np.ndarray) -> None:
        for f in P.FIELDS:
            getattr(self.s, f)[idx] = getattr(sub, f)

    # --- 初期化 ---------------------------------------------------------------
    def reset(self, mask: np.ndarray) -> None:
        k = int(mask.sum())
        if not k:
            return
        # 終わった面は、コースと車も選び直す
        self.group[mask] = self.rng.integers(0, len(self.courses) * len(self.cars), k)
        self.t[mask] = 0.0
        self.since_check[mask] = 0.0
        for course, car, idx in self.slices():
            hit = idx[mask[idx]]
            if not len(hit):
                continue
            sub = self.sub(hit)
            start = self.rng.integers(0, course.n, len(hit))
            lane = self.rng.uniform(-0.35, 0.35, len(hit)) * course.width[start]
            speed = self.rng.uniform(0.0, car.vmax * 0.8, len(hit))
            P.reset(sub, np.ones(len(hit), dtype=bool), course, start, lane, speed)
            self.write(sub, hit)
        self.check_prog[mask] = self.s.prog[mask]

    def observe(self) -> np.ndarray:
        out = np.zeros((self.n, P.OBS_DIM), dtype=np.float32)
        for course, car, idx in self.slices():
            out[idx] = P.observe(self.sub(idx), car, course)
        return out

    # --- 1 ステップ -------------------------------------------------------------
    def step(self, action: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        """action: (N, 3)、-1〜1。戻り値: (次の観測, 報酬, 終わったか, 集計)"""
        a = action.astype(np.float64)
        reward = np.zeros(self.n)
        hits = np.zeros(self.n)
        falls = np.zeros(self.n)
        tricks = np.zeros(self.n)
        before = self.s.prog.copy()

        for course, car, idx in self.slices():
            sub = self.sub(idx)
            th, st, jp = a[idx, 0], a[idx, 1], a[idx, 2]
            for _ in range(FRAME_SKIP):
                ev = P.step(sub, car, course, th, st, jp)
                hits[idx] += ev["hit"]
                falls[idx] += ev["fell"]
                tricks[idx] += ev["tricks"]
            self.write(sub, idx)

        gained = self.s.prog - before
        reward += R_PROGRESS * gained
        reward += R_BACKWARD * np.minimum(gained, 0.0)  # 後退はよけいに損
        reward += R_HIT * hits
        reward += R_FALL * falls
        reward += R_TRICK * tricks

        self.t += FRAME_SKIP * P.DT
        # 進まなくなった面を見つける（壁にはまって空回りし続けるのを防ぐ）
        self.since_check += FRAME_SKIP * P.DT
        check = self.since_check >= STUCK_SECONDS
        stuck = check & (self.s.prog - self.check_prog < STUCK_DISTANCE)
        self.check_prog = np.where(check, self.s.prog, self.check_prog)
        self.since_check = np.where(check, 0.0, self.since_check)

        done = (self.t >= MAX_SECONDS) | stuck
        self.reset(done)
        info = {"hits": hits, "falls": falls, "tricks": tricks, "gained": gained, "stuck": stuck}
        return self.observe(), reward.astype(np.float32), done, info


# --- 評価 ---------------------------------------------------------------------

def _drive(policy, course: CO.Course, car: P.Car, laps: int = 1, n: int = 8,
           seed: int = 0, heuristic: bool = False, skill: float = 1.0) -> dict:
    """スタート地点から laps 周走らせて、タイムと道中の出来事を返す。

    n 台を少しずつ違う位置に並べて走らせ、その平均を取る（1 台だとぶれるため）。
    """
    rng = np.random.default_rng(seed)
    s = P.State.zeros(n)
    lane = rng.uniform(-0.3, 0.3, n) * course.width[0]
    P.reset(s, np.ones(n, dtype=bool), course, None, lane, np.zeros(n))
    limit = int(180 / P.DT)
    finish = np.full(n, np.nan)
    falls = np.zeros(n)
    tricks = np.zeros(n)
    hits = np.zeros(n)
    for step_i in range(limit):
        if heuristic:
            th, st, jp = P.heuristic_action(s, car, course, skill)
        else:
            with torch.no_grad():
                obs = torch.from_numpy(P.observe(s, car, course))
                a = policy.act(obs, deterministic=True).numpy().astype(np.float64)
            th, st, jp = a[:, 0], a[:, 1], a[:, 2]
        ev = P.step(s, car, course, th, st, jp)
        falls += ev["fell"]
        tricks += ev["tricks"]
        hits += ev["hit"]
        done = np.isnan(finish) & (s.lap >= laps)
        finish = np.where(done, step_i * P.DT, finish)
        if not np.isnan(finish).any():
            break
    # 完走できなかった車は、その時点の進み具合から推定したタイムにする（大きな値になる）
    unfinished = np.isnan(finish)
    est = np.where(s.prog > 1, limit * P.DT * (course.length * laps) / np.maximum(s.prog, 1), limit * P.DT)
    finish = np.where(unfinished, np.minimum(est, 300.0), finish)
    return {
        "lap_sec": float(np.mean(finish) / laps),
        "completed": float((~unfinished).mean()),
        "falls": float(falls.mean() / laps),
        "tricks": float(tricks.mean() / laps),
        "hit_rate": float(hits.mean() / max(1, limit)),
    }


def evaluate(policy, car_id: str = "balanced", laps: int = 1, seed: int = 0) -> dict:
    """全コースで 1 周走らせ、学習なしの運転者のタイムと比べる。

    戻り値の形は apps/training が読んで強さページに出す（frontend の RacerStatsPage.tsx と対応）。
    """
    car = P.load_car(car_id)
    results: dict[str, dict] = {}
    for cid in CO.course_ids():
        course = CO.load(cid)
        ai = _drive(policy, course, car, laps, seed=seed)
        base = _drive(None, course, car, laps, seed=seed, heuristic=True)
        ai["heuristic_sec"] = base["lap_sec"]
        ai["ratio"] = base["lap_sec"] / max(ai["lap_sec"], 1e-6)
        results[cid] = ai
    score = float(np.mean([r["ratio"] for r in results.values()]))
    return {"score": score, "results": results}
