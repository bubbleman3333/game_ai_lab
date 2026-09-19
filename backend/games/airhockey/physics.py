"""エアホッケーの物理（numpy で N 面を同時に計算する）。Django・PyTorch に依存しない。

座標: 台の幅 W=1.0（x: 0〜1）、長さ L=2.0（y: 0〜2）。
プレイヤー 0 は手前（y < 1、y=0 側のゴールを守る）、プレイヤー 1 は奥（y > 1、y=2 側を守る）。
TypeScript 版（frontend/src/games/airhockey/engine/physics.ts）はここと同じ式・同じ順番で計算する。
式や定数を変えたら両方を直し、`python -m games.airhockey.fixtures` でテストデータを作り直す。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

W = 1.0
L = 2.0
GOAL_HALF = 0.15  # ゴールの口の半分の幅
PUCK_R = 0.035
MALLET_R = 0.06
MALLET_VMAX = 3.0  # マレット（打つ道具）の最高速度（/秒）
PUCK_VMAX = 6.0
WALL_E = 0.9  # 壁の反発係数
MALLET_E = 0.9  # マレットの反発係数
FRICTION = 0.998  # 1 ステップごとの減速
DT = 1 / 60  # 1 ステップの時間（秒）


@dataclass
class State:
    """N 面分の状態。すべて形 (N,) の配列。m0 = プレイヤー 0 のマレット、m1 = プレイヤー 1。"""

    px: np.ndarray
    py: np.ndarray
    pvx: np.ndarray
    pvy: np.ndarray
    m0x: np.ndarray
    m0y: np.ndarray
    m0vx: np.ndarray
    m0vy: np.ndarray
    m1x: np.ndarray
    m1y: np.ndarray
    m1vx: np.ndarray
    m1vy: np.ndarray

    @classmethod
    def zeros(cls, n: int) -> "State":
        return cls(*(np.zeros(n) for _ in range(12)))

    def copy(self) -> "State":
        return State(*(getattr(self, f).copy() for f in FIELDS))


FIELDS = ("px", "py", "pvx", "pvy", "m0x", "m0y", "m0vx", "m0vy", "m1x", "m1y", "m1vx", "m1vy")


SERVE_JITTER_X = 0.25  # サーブ位置のばらつき（毎回同じ展開にならないように）
SERVE_JITTER_Y = 0.1


def reset(s: State, mask: np.ndarray, serve_to: np.ndarray, rng: np.random.Generator | None = None) -> None:
    """mask の面を初期配置に戻す。serve_to: パックを置く側（0 = 手前、1 = 奥）。

    rng を渡すとパックの位置を少しずらす（学習・評価用）。渡さなければ真ん中（テストデータ用）。
    """
    k = int(mask.sum())
    jx = rng.uniform(-SERVE_JITTER_X, SERVE_JITTER_X, k) if rng is not None else 0.0
    jy = rng.uniform(-SERVE_JITTER_Y, SERVE_JITTER_Y, k) if rng is not None else 0.0
    s.px[mask] = W / 2 + jx
    s.py[mask] = np.where(serve_to[mask] == 0, L * 0.3, L * 0.7) + jy
    for f in ("pvx", "pvy", "m0vx", "m0vy", "m1vx", "m1vy"):
        getattr(s, f)[mask] = 0.0
    s.m0x[mask] = W / 2
    s.m0y[mask] = L * 0.1
    s.m1x[mask] = W / 2
    s.m1y[mask] = L * 0.9


def _move_mallet(x, y, vx_des, vy_des, ymin, ymax):
    """望む速度で動かし、自分の陣地からはみ出さないようにする。戻り値: (x, y, vx, vy)。"""
    speed = np.sqrt(vx_des * vx_des + vy_des * vy_des)
    scale = np.where(speed > MALLET_VMAX, MALLET_VMAX / np.maximum(speed, 1e-9), 1.0)
    vx = vx_des * scale
    vy = vy_des * scale
    nx = np.clip(x + vx * DT, MALLET_R, W - MALLET_R)
    ny = np.clip(y + vy * DT, ymin, ymax)
    # はみ出して止められた分は速度にも反映する（当たったときの勢いを正しくするため）
    return nx, ny, (nx - x) / DT, (ny - y) / DT


def _collide(s: State, mx, my, mvx, mvy) -> None:
    dx = s.px - mx
    dy = s.py - my
    dist = np.sqrt(dx * dx + dy * dy)
    hit = dist < PUCK_R + MALLET_R
    safe = np.maximum(dist, 1e-9)
    nx = dx / safe
    ny = dy / safe
    # 重なったらパックを押し出す
    s.px = np.where(hit, mx + nx * (PUCK_R + MALLET_R), s.px)
    s.py = np.where(hit, my + ny * (PUCK_R + MALLET_R), s.py)
    # 近づく向きに動いていたら跳ね返す（マレットは重さ無限大とみなす）
    vn = (s.pvx - mvx) * nx + (s.pvy - mvy) * ny
    bounce = hit & (vn < 0)
    s.pvx = np.where(bounce, s.pvx - (1 + MALLET_E) * vn * nx, s.pvx)
    s.pvy = np.where(bounce, s.pvy - (1 + MALLET_E) * vn * ny, s.pvy)


def step(s: State, a0x, a0y, a1x, a1y) -> np.ndarray:
    """1 ステップ進める。a*: 各マレットの望む速度（/秒）。

    戻り値: 各面のゴール（0 = 誰も入れていない、+1 = プレイヤー 0 が決めた、-1 = プレイヤー 1 が決めた）。
    ゴールした面の状態はそのまま（呼び出し側が reset する）。
    """
    s.m0x, s.m0y, s.m0vx, s.m0vy = _move_mallet(s.m0x, s.m0y, a0x, a0y, MALLET_R, L / 2 - MALLET_R)
    s.m1x, s.m1y, s.m1vx, s.m1vy = _move_mallet(s.m1x, s.m1y, a1x, a1y, L / 2 + MALLET_R, L - MALLET_R)

    s.px = s.px + s.pvx * DT
    s.py = s.py + s.pvy * DT

    # 左右の壁
    left = s.px < PUCK_R
    s.px = np.where(left, PUCK_R, s.px)
    s.pvx = np.where(left & (s.pvx < 0), -s.pvx * WALL_E, s.pvx)
    right = s.px > W - PUCK_R
    s.px = np.where(right, W - PUCK_R, s.px)
    s.pvx = np.where(right & (s.pvx > 0), -s.pvx * WALL_E, s.pvx)

    # 手前と奥の壁（ゴールの口の中は壁がない）
    in_mouth = np.abs(s.px - W / 2) < GOAL_HALF
    near = (s.py < PUCK_R) & ~in_mouth
    s.py = np.where(near, PUCK_R, s.py)
    s.pvy = np.where(near & (s.pvy < 0), -s.pvy * WALL_E, s.pvy)
    far = (s.py > L - PUCK_R) & ~in_mouth
    s.py = np.where(far, L - PUCK_R, s.py)
    s.pvy = np.where(far & (s.pvy > 0), -s.pvy * WALL_E, s.pvy)

    _collide(s, s.m0x, s.m0y, s.m0vx, s.m0vy)
    _collide(s, s.m1x, s.m1y, s.m1vx, s.m1vy)

    # マレットに押し出されて壁にめり込んだ分を戻す（隅で押しつけても壁を抜けないように）
    s.px = np.clip(s.px, PUCK_R, W - PUCK_R)
    in_mouth = np.abs(s.px - W / 2) < GOAL_HALF
    s.py = np.where(in_mouth, s.py, np.clip(s.py, PUCK_R, L - PUCK_R))

    # 摩擦と速度の上限
    s.pvx = s.pvx * FRICTION
    s.pvy = s.pvy * FRICTION
    speed = np.sqrt(s.pvx * s.pvx + s.pvy * s.pvy)
    scale = np.where(speed > PUCK_VMAX, PUCK_VMAX / np.maximum(speed, 1e-9), 1.0)
    s.pvx = s.pvx * scale
    s.pvy = s.pvy * scale

    goal = np.zeros_like(s.px)
    goal = np.where(in_mouth & (s.py < 0), -1.0, goal)  # 手前のゴールに入った → プレイヤー 1 の得点
    goal = np.where(in_mouth & (s.py > L), 1.0, goal)
    return goal


def observe(s: State, player: int) -> np.ndarray:
    """プレイヤーから見た観測（形 (N, 12)）。プレイヤー 1 は盤を 180° 回して、自分が手前にいるように見せる。

    並び: 自分のマレット x, y, vx, vy / 相手のマレット x, y, vx, vy / パック x, y, vx, vy
    位置は -1〜1、速度は最高速度で割った値。
    """
    if player == 0:
        own = (s.m0x, s.m0y, s.m0vx, s.m0vy)
        opp = (s.m1x, s.m1y, s.m1vx, s.m1vy)
        puck = (s.px, s.py, s.pvx, s.pvy)
    else:
        own = (W - s.m1x, L - s.m1y, -s.m1vx, -s.m1vy)
        opp = (W - s.m0x, L - s.m0y, -s.m0vx, -s.m0vy)
        puck = (W - s.px, L - s.py, -s.pvx, -s.pvy)

    def pos(x, y):
        return [x / W * 2 - 1, y / L * 2 - 1]

    cols = (
        pos(own[0], own[1]) + [own[2] / MALLET_VMAX, own[3] / MALLET_VMAX]
        + pos(opp[0], opp[1]) + [opp[2] / MALLET_VMAX, opp[3] / MALLET_VMAX]
        + pos(puck[0], puck[1]) + [puck[2] / PUCK_VMAX, puck[3] / PUCK_VMAX]
    )
    return np.stack(cols, axis=1).astype(np.float32)


def action_to_world(ax: np.ndarray, ay: np.ndarray, player: int) -> tuple[np.ndarray, np.ndarray]:
    """方策の出力（-1〜1、自分から見た向き）を、盤上の速度（/秒）にする。"""
    vx = ax * MALLET_VMAX
    vy = ay * MALLET_VMAX
    return (vx, vy) if player == 0 else (-vx, -vy)


def heuristic_action(s: State, player: int, speed: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """学習なしの AI: パックが自陣にあれば打ちに行き、なければゴールの前で守る。盤上の速度を返す。"""
    if player == 0:
        mx, my, px, py, pvy = s.m0x, s.m0y, s.px, s.py, s.pvy
    else:
        mx, my, px, py, pvy = W - s.m1x, L - s.m1y, W - s.px, L - s.py, -s.pvy
    in_my_half = py < L / 2
    # 打つ: パックの少し後ろ（自分のゴール側）を狙って突っ込む
    attack_x, attack_y = px, py - PUCK_R
    # 守る: ゴールとパックを結ぶ線上、ゴールの少し前
    guard_x = W / 2 + (px - W / 2) * 0.3
    guard_y = np.full_like(px, L * 0.08)
    tx = np.where(in_my_half & (pvy < 1.0), attack_x, guard_x)
    ty = np.where(in_my_half & (pvy < 1.0), attack_y, guard_y)
    vx = (tx - mx) / DT
    vy = (ty - my) / DT
    sp = np.sqrt(vx * vx + vy * vy)
    k = np.where(sp > MALLET_VMAX * speed, MALLET_VMAX * speed / np.maximum(sp, 1e-9), 1.0)
    vx, vy = vx * k, vy * k
    return (vx, vy) if player == 0 else (-vx, -vy)
