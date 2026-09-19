// エアホッケーの物理（1 面分）。backend/games/airhockey/physics.py と同じ式・同じ順番で計算する
// （shared/fixtures/airhockey/engine_cases.json で一致を確認）。React・DOM には依存しない。
// 座標: 幅 W=1（x）、長さ L=2（y）。プレイヤー 0 は手前（y が小さい側）、プレイヤー 1 は奥。

export const W = 1.0
export const L = 2.0
export const GOAL_HALF = 0.15
export const PUCK_R = 0.035
export const MALLET_R = 0.06
export const MALLET_VMAX = 3.0
export const PUCK_VMAX = 6.0
const WALL_E = 0.9
const MALLET_E = 0.9
const FRICTION = 0.998
export const DT = 1 / 60

export interface State {
  px: number; py: number; pvx: number; pvy: number
  m0x: number; m0y: number; m0vx: number; m0vy: number
  m1x: number; m1y: number; m1vx: number; m1vy: number
}

export const FIELDS: (keyof State)[] = [
  'px', 'py', 'pvx', 'pvy', 'm0x', 'm0y', 'm0vx', 'm0vy', 'm1x', 'm1y', 'm1vx', 'm1vy',
]

export function initialState(serveTo: 0 | 1): State {
  return {
    px: W / 2, py: serveTo === 0 ? L * 0.3 : L * 0.7, pvx: 0, pvy: 0,
    m0x: W / 2, m0y: L * 0.1, m0vx: 0, m0vy: 0,
    m1x: W / 2, m1y: L * 0.9, m1vx: 0, m1vy: 0,
  }
}

const clip = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function moveMallet(x: number, y: number, vxDes: number, vyDes: number, ymin: number, ymax: number): [number, number, number, number] {
  const speed = Math.sqrt(vxDes * vxDes + vyDes * vyDes)
  const scale = speed > MALLET_VMAX ? MALLET_VMAX / Math.max(speed, 1e-9) : 1.0
  const vx = vxDes * scale
  const vy = vyDes * scale
  const nx = clip(x + vx * DT, MALLET_R, W - MALLET_R)
  const ny = clip(y + vy * DT, ymin, ymax)
  return [nx, ny, (nx - x) / DT, (ny - y) / DT]
}

function collide(s: State, mx: number, my: number, mvx: number, mvy: number): boolean {
  const dx = s.px - mx
  const dy = s.py - my
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (!(dist < PUCK_R + MALLET_R)) return false
  const safe = Math.max(dist, 1e-9)
  const nx = dx / safe
  const ny = dy / safe
  s.px = mx + nx * (PUCK_R + MALLET_R)
  s.py = my + ny * (PUCK_R + MALLET_R)
  const vn = (s.pvx - mvx) * nx + (s.pvy - mvy) * ny
  if (vn < 0) {
    s.pvx = s.pvx - (1 + MALLET_E) * vn * nx
    s.pvy = s.pvy - (1 + MALLET_E) * vn * ny
    return true
  }
  return false
}

export interface StepEvents {
  /** 0 = なし、+1 = プレイヤー 0 の得点、-1 = プレイヤー 1 の得点 */
  goal: number
  /** 音を鳴らすための出来事 */
  hitMallet: boolean
  hitWall: boolean
}

/** 1 ステップ進める（s を直接書き換える）。a*: 各マレットの望む速度（/秒） */
export function step(s: State, a0x: number, a0y: number, a1x: number, a1y: number): StepEvents {
  ;[s.m0x, s.m0y, s.m0vx, s.m0vy] = moveMallet(s.m0x, s.m0y, a0x, a0y, MALLET_R, L / 2 - MALLET_R)
  ;[s.m1x, s.m1y, s.m1vx, s.m1vy] = moveMallet(s.m1x, s.m1y, a1x, a1y, L / 2 + MALLET_R, L - MALLET_R)

  s.px = s.px + s.pvx * DT
  s.py = s.py + s.pvy * DT
  let hitWall = false

  if (s.px < PUCK_R) {
    s.px = PUCK_R
    if (s.pvx < 0) { s.pvx = -s.pvx * WALL_E; hitWall = true }
  }
  if (s.px > W - PUCK_R) {
    s.px = W - PUCK_R
    if (s.pvx > 0) { s.pvx = -s.pvx * WALL_E; hitWall = true }
  }
  const inMouth = Math.abs(s.px - W / 2) < GOAL_HALF
  if (s.py < PUCK_R && !inMouth) {
    s.py = PUCK_R
    if (s.pvy < 0) { s.pvy = -s.pvy * WALL_E; hitWall = true }
  }
  if (s.py > L - PUCK_R && !inMouth) {
    s.py = L - PUCK_R
    if (s.pvy > 0) { s.pvy = -s.pvy * WALL_E; hitWall = true }
  }

  const h0 = collide(s, s.m0x, s.m0y, s.m0vx, s.m0vy)
  const h1 = collide(s, s.m1x, s.m1y, s.m1vx, s.m1vy)

  // マレットに押し出されて壁にめり込んだ分を戻す（隅で押しつけても壁を抜けないように）
  s.px = clip(s.px, PUCK_R, W - PUCK_R)
  const inMouth2 = Math.abs(s.px - W / 2) < GOAL_HALF
  if (!inMouth2) s.py = clip(s.py, PUCK_R, L - PUCK_R)

  s.pvx = s.pvx * FRICTION
  s.pvy = s.pvy * FRICTION
  const speed = Math.sqrt(s.pvx * s.pvx + s.pvy * s.pvy)
  const scale = speed > PUCK_VMAX ? PUCK_VMAX / Math.max(speed, 1e-9) : 1.0
  s.pvx = s.pvx * scale
  s.pvy = s.pvy * scale

  let goal = 0
  if (inMouth2 && s.py < 0) goal = -1
  if (inMouth2 && s.py > L) goal = 1
  return { goal, hitMallet: h0 || h1, hitWall }
}

/** プレイヤーから見た観測（12 個）。プレイヤー 1 は盤を 180° 回して見る */
export function observe(s: State, player: 0 | 1): number[] {
  const own = player === 0
    ? [s.m0x, s.m0y, s.m0vx, s.m0vy]
    : [W - s.m1x, L - s.m1y, -s.m1vx, -s.m1vy]
  const opp = player === 0
    ? [s.m1x, s.m1y, s.m1vx, s.m1vy]
    : [W - s.m0x, L - s.m0y, -s.m0vx, -s.m0vy]
  const puck = player === 0
    ? [s.px, s.py, s.pvx, s.pvy]
    : [W - s.px, L - s.py, -s.pvx, -s.pvy]
  const pos = (x: number, y: number) => [x / W * 2 - 1, y / L * 2 - 1]
  return [
    ...pos(own[0], own[1]), own[2] / MALLET_VMAX, own[3] / MALLET_VMAX,
    ...pos(opp[0], opp[1]), opp[2] / MALLET_VMAX, opp[3] / MALLET_VMAX,
    ...pos(puck[0], puck[1]), puck[2] / PUCK_VMAX, puck[3] / PUCK_VMAX,
  ]
}

/** 方策の出力（-1〜1、自分から見た向き）→ 盤上の速度 */
export function actionToWorld(ax: number, ay: number, player: 0 | 1): [number, number] {
  const vx = ax * MALLET_VMAX
  const vy = ay * MALLET_VMAX
  return player === 0 ? [vx, vy] : [-vx, -vy]
}

/** 学習なしの AI（physics.py の heuristic_action と同じ） */
export function heuristicAction(s: State, player: 0 | 1, speed = 1.0): [number, number] {
  const [mx, my, px, py, pvy] = player === 0
    ? [s.m0x, s.m0y, s.px, s.py, s.pvy]
    : [W - s.m1x, L - s.m1y, W - s.px, L - s.py, -s.pvy]
  const attack = py < L / 2 && pvy < 1.0
  const tx = attack ? px : W / 2 + (px - W / 2) * 0.3
  const ty = attack ? py - PUCK_R : L * 0.08
  let vx = (tx - mx) / DT
  let vy = (ty - my) / DT
  const sp = Math.sqrt(vx * vx + vy * vy)
  const k = sp > MALLET_VMAX * speed ? MALLET_VMAX * speed / Math.max(sp, 1e-9) : 1.0
  vx = vx * k
  vy = vy * k
  return player === 0 ? [vx, vy] : [-vx, -vy]
}

/** 人の操作: マウスの位置へ向かう速度（最高速度は AI と同じ） */
export function towards(s: State, player: 0 | 1, tx: number, ty: number): [number, number] {
  const mx = player === 0 ? s.m0x : s.m1x
  const my = player === 0 ? s.m0y : s.m1y
  return [(tx - mx) / DT, (ty - my) / DT]
}
