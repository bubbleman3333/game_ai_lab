// レースの物理（1 台分）。backend/games/racer/physics.py と同じ式・同じ順番で計算する
// （shared/fixtures/racer/engine_cases.json で一致を確認）。React・DOM には依存しない。
//
// 3D に見えるが、計算しているのは「平面の上を走る車 + 高さ」だけ。
// ジャンプは特別扱いしていない。接地しているあいだ、車は「地面の高さの変わりぶん」を
// そのまま上向きの速度として持つ。だから坂をのぼりきったところ（丘の頂上・ジャンプ台の終わり）
// では、地面が下がるのに上向きの速度が残っているので、そのまま宙に浮く。
// 速く走るほど上向きの速度が大きくなり、遠くまで飛ぶ。
//
// State の項目名は Python 版とそろえてある（見比べやすいように snake_case のまま）。
//
// 向きの決まりは engine/course.ts の冒頭を見ること。運転者から見た右は (-cos yaw, sin yaw) で、
// 右へ曲がると yaw は減る。右手系で上が +y・前が +z のとき、画面の右はワールドの -x になるため。

import * as CO from './course'

export const DT = 1 / 60
export const GRAVITY = 26.0
const GAP_DROP = 200.0

const STEER_REF = 3.0
// 横方向にどれだけ踏ん張れるか（m/s²）。速いほど曲がれる角速度がこれで頭打ちになる
const LAT_BASE = 12.0
const LAT_PER_GRIP = 0.9
const BRAKE_SLIDE = 0.55 // ブレーキ中の横グリップの倍率
const ALIGN = 1.0 // 滑っているとき、車の向きが進行方向へ戻る速さ（1/秒）
const REVERSE_MAX = 9.0
export const BOOST_TIME = 1.8
const BOOST_ACCEL = 26.0
export const BOOST_VMAX = 1.3
const TRICK_BOOST = 0.8
export const TRICK_TURN = Math.PI // トリック 1 回ぶんの角度（半回転）

const DIRT_GRIP = 0.45
const DIRT_ACCEL = 0.72
const BANK_GRIP = 1.2

const AIR_LAT_DRAG = 0.4
const WALL_DRAG = 0.6
const GROUND_EPS = 0.02
const LAND_REACH = 3.0
const SLOPE_VY_MIN = 1.0
const FALL_LIMIT = 10.0
export const RESPAWN_TIME = 1.4
const RESPAWN_BACK = 45.0
const RESPAWN_SPEED = 8.0
const JUMP_COOLDOWN = 0.35

export interface Car {
  id: string
  name: string
  description: string
  accel: number
  brake: number
  vmax: number
  grip: number
  steer: number
  jump: number
  air_control: number
  drag: number
}

export interface State {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  yaw: number
  seg: number
  prog: number
  lap: number
  on_ground: number
  boost: number
  spin: number
  air: number
  cool: number
  respawn: number
}

export const FIELDS: (keyof State)[] = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'seg', 'prog', 'lap',
  'on_ground', 'boost', 'spin', 'air', 'cool', 'respawn',
]

export interface Events {
  landed: boolean
  tricks: number
  fell: boolean
  lapped: boolean
  hit: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** コース上に車を置く。lane は中心線からの左右のずれ（m）、speed は初速。 */
export function initialState(c: CO.Course, startSeg = 0, lane = 0, speed = 0): State {
  const idx = CO.mod(Math.trunc(startSeg), c.n)
  const head = c.heading[idx]
  const rx = -Math.cos(head), rz = Math.sin(head)
  return {
    x: c.x[idx] + rx * lane, y: c.y[idx], z: c.z[idx] + rz * lane,
    vx: Math.sin(head) * speed, vy: 0, vz: Math.cos(head) * speed,
    yaw: head, seg: idx, prog: 0, lap: 0,
    on_ground: 1, boost: 0, spin: 0, air: 0, cool: 0, respawn: 0,
  }
}

/** 中心線の点 idx から前後にどれだけずれているか（点の番号を単位にした値） */
function along(c: CO.Course, idx: number, x: number, z: number): number {
  const head = c.heading[idx]
  return ((x - c.x[idx]) * Math.sin(head) + (z - c.z[idx]) * Math.cos(head)) / c.spacing
}

/** その位置の地面の高さ。点と点のあいだは直線でつなぐ（そうしないと車が跳ねる） */
function groundHeight(c: CO.Course, idx: number, a: number): number {
  const nb = CO.mod(idx + (a >= 0 ? 1 : -1), c.n)
  const y = c.y[idx] + (c.y[nb] - c.y[idx]) * Math.abs(a)
  return c.kind[idx] === CO.KIND_GAP ? y - GAP_DROP : y
}

function respawn(s: State, c: CO.Course): void {
  const back = Math.round(RESPAWN_BACK / c.spacing)
  const idx = c.safe[CO.mod(Math.trunc(s.seg) - back, c.n)]
  const head = c.heading[idx]
  s.x = c.x[idx]; s.y = c.y[idx]; s.z = c.z[idx]
  s.yaw = head; s.seg = idx
  s.vx = Math.sin(head) * RESPAWN_SPEED
  s.vy = 0
  s.vz = Math.cos(head) * RESPAWN_SPEED
  s.on_ground = 1
  s.boost = 0
  s.spin = 0
  s.air = 0
  s.respawn = RESPAWN_TIME
}

/**
 * 1 ステップ（1/60 秒）進める。s は書き換わる。
 * throttle: -1〜1（1 = 全開、-1 = ブレーキ / 後退）、steer: -1〜1（1 = 右）、
 * jump: -1〜1（0.5 を超えたら跳ぶ）。steer の「右」は運転者から見た右で、画面でも右へ曲がる。
 */
export function step(s: State, car: Car, c: CO.Course,
                     throttle: number, steer: number, jump: number): Events {
  const n = c.n
  const idx0 = Math.trunc(s.seg)
  const along0 = along(c, idx0, s.x, s.z)
  const ground0 = groundHeight(c, idx0, along0)
  const kind = c.kind[idx0]
  const bank = c.bank[idx0]

  // --- 復帰中は操作を受け付けない ---
  const waiting = s.respawn > 0
  s.respawn = Math.max(0, s.respawn - DT)
  const th = waiting ? 0 : throttle
  const st = waiting ? 0 : steer
  const jp = waiting ? -1 : jump

  // --- 速度を「前後」と「横」に分ける ---
  let fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
  let rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw)
  let vlong = s.vx * fx + s.vz * fz
  let vlat = s.vx * rx + s.vz * rz

  const grounded = s.on_ground > 0.5
  const dirt = kind === CO.KIND_DIRT
  const gripMul = (dirt ? DIRT_GRIP : 1) * (1 + Math.abs(bank) * BANK_GRIP)
  const accelMul = dirt ? DIRT_ACCEL : 1

  // --- ブースト ---
  if (grounded && kind === CO.KIND_BOOST) s.boost = BOOST_TIME
  const boosting = s.boost > 0
  s.boost = Math.max(0, s.boost - DT)

  // --- 向きを変える ---
  // 接地中は前輪で曲がるが、「曲がれる速さ」はグリップで頭打ちになる
  // （速いほど、同じ角速度で曲がるのに必要な横方向の加速度が大きくなるため）
  const latAccel = (LAT_BASE + LAT_PER_GRIP * car.grip) * gripMul
  const maxTurn = latAccel / Math.max(Math.abs(vlong), 1)
  const speedRef = clamp(Math.abs(vlong) / STEER_REF, 0, 1)
  const turnGround = st * Math.min(car.steer, maxTurn) * speedRef * (vlong < 0 ? -1 : 1)
  const turn = grounded ? turnGround : st * car.air_control
  // 滑っているあいだは、車の向きがじわっと進行方向へ戻る（立て直しやすくする）
  const align = grounded ? ALIGN * Math.atan2(vlat, Math.max(Math.abs(vlong), 1)) : 0
  s.yaw -= (turn + align) * DT
  if (!grounded) s.spin -= turn * DT

  // --- 前後の速さ ---
  const drive = th >= 0 ? th * car.accel * accelMul : th * car.brake
  vlong += (grounded ? drive : 0) * DT
  vlong += (grounded && boosting ? BOOST_ACCEL : 0) * DT
  vlong -= car.drag * vlong * DT
  vlong = clamp(vlong, -REVERSE_MAX, car.vmax * (boosting ? BOOST_VMAX : 1))

  // --- 横滑り（減りきらずに残ったぶんがドリフトになる）---
  const braking = th < -0.5 // ブレーキを踏むと横グリップが落ちて、滑らせて向きを変えられる
  vlat *= grounded
    ? Math.max(0, 1 - car.grip * gripMul * (braking ? BRAKE_SLIDE : 1) * DT)
    : Math.max(0, 1 - AIR_LAT_DRAG * DT)

  // --- ワールド座標の速度に戻す（向きを変えたあとの前後左右で組み立てる）---
  fx = Math.sin(s.yaw); fz = Math.cos(s.yaw)
  rx = -Math.cos(s.yaw); rz = Math.sin(s.yaw)
  s.vx = vlong * fx + vlat * rx
  s.vz = vlong * fz + vlat * rz

  // --- 自分で跳ぶ ---
  const canJump = grounded && jp > 0.5 && s.cool <= 0
  if (canJump) { s.vy = car.jump; s.cool = JUMP_COOLDOWN } else { s.cool = Math.max(0, s.cool - DT) }

  // --- 上下 ---
  s.vy -= GRAVITY * DT
  s.x += s.vx * DT
  s.y += s.vy * DT
  s.z += s.vz * DT

  // --- 移動後のコース上の位置 ---
  const idx = CO.nearest(c, s.x, s.z, idx0)
  s.seg = idx
  const cx = c.x[idx], cz = c.z[idx]
  const chead = c.heading[idx], cwidth = c.width[idx]
  const a1 = along(c, idx, s.x, s.z)
  const ground = groundHeight(c, idx, a1)

  // --- 接地したか ---
  // 地面より十分下にいるときは接地させない（落下中に道へ吸い上げられないように）
  const nowGround = s.y <= ground + GROUND_EPS && s.y > ground - LAND_REACH
  const landed = nowGround && !grounded
  // 坂で得られる上向きの速さには上限をつける。ジャンプ台の終わりは崖なので、
  // そこを逆走などで乗り越えると地面が 1 ステップで数 m 跳ね上がり、車が空へ飛んでいってしまう
  const lim = Math.sqrt(s.vx * s.vx + s.vz * s.vz) + SLOPE_VY_MIN
  const slopeVy = clamp((ground - ground0) / DT, -lim, lim)
  if (nowGround) { s.y = ground; s.vy = slopeVy }
  s.on_ground = nowGround ? 1 : 0
  s.air = nowGround ? 0 : s.air + DT

  // --- トリック（空中で回ってから着地するとブースト）---
  const tricks = landed ? Math.floor(Math.abs(s.spin) / TRICK_TURN) : 0
  s.boost += tricks * TRICK_BOOST
  if (nowGround) s.spin = 0

  // --- コースの端（ガードレール）。接地しているときだけ当たる ---
  const srx = -Math.cos(chead), srz = Math.sin(chead)
  const lateral = (s.x - cx) * srx + (s.z - cz) * srz
  const over = Math.abs(lateral) - cwidth / 2
  const hit = nowGround && over > 0
  const push = hit ? Math.sign(lateral) * over : 0
  s.x -= push * srx
  s.z -= push * srz
  // 壁の外を向いている速度だけを消す。前へ進む速度はそのまま残し、
  // 擦っているあいだ「1 秒あたり」で減速させる
  // （1 フレームごとの掛け算にすると、壁に触れた車が 1 秒で止まってしまう）
  const vn = s.vx * srx + s.vz * srz
  if (hit && Math.sign(vn) === Math.sign(lateral) && lateral !== 0) {
    s.vx -= vn * srx
    s.vz -= vn * srz
  }
  if (hit) {
    const scrape = Math.max(0, 1 - WALL_DRAG * DT)
    s.vx *= scrape
    s.vz *= scrape
  }

  // --- 進んだ距離と周回 ---
  const delta = CO.mod((idx + a1) - (idx0 + along0) + n / 2, n) - n / 2
  s.prog += delta * c.spacing
  const done = Math.floor(s.prog / c.length)
  const lapped = done > s.lap
  s.lap = Math.max(s.lap, done)

  // --- 落ちたらコースへ戻す ---
  const fell = s.y < c.y[idx] - FALL_LIMIT
  if (fell) respawn(s, c)

  return { landed: landed && !fell, tricks, fell, lapped, hit }
}

// --- AI が見るもの ------------------------------------------------------------

const LOOKAHEAD = [12.0, 25.0, 42.0, 62.0, 88.0, 120.0]
export const OBS_DIM = 8 + 3 * LOOKAHEAD.length + 4 // 30

/** 車から見た観測（OBS_DIM 個）。並びは Python 版 observe() と同じ */
export function observe(s: State, car: Car, c: CO.Course): number[] {
  const idx = Math.trunc(s.seg)
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
  const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw)
  const vlong = s.vx * fx + s.vz * fz
  const vlat = s.vx * rx + s.vz * rz

  const cx = c.x[idx], cz = c.z[idx]
  const chead = c.heading[idx], cwidth = c.width[idx]
  const srx = -Math.cos(chead), srz = Math.sin(chead)
  const lateral = (s.x - cx) * srx + (s.z - cz) * srz
  const err = CO.wrapAngle(chead - s.yaw)

  const out: number[] = [
    vlong / car.vmax,
    vlat / car.vmax,
    clamp(s.vy / 20, -2, 2),
    s.on_ground,
    s.boost / BOOST_TIME,
    clamp(lateral / (cwidth / 2), -2, 2),
    Math.sin(err),
    Math.cos(err),
  ]
  for (const d of LOOKAHEAD) {
    const j = CO.mod(idx + Math.round(d / c.spacing), c.n)
    const dx = c.x[j] - s.x, dz = c.z[j] - s.z
    out.push((dx * rx + dz * rz) / d)
    out.push(clamp((c.y[j] - s.y) / 10, -2, 2))
    out.push(c.width[j] / 20)
  }
  for (const want of [CO.KIND_BOOST, CO.KIND_DIRT, CO.KIND_RAMP, CO.KIND_GAP]) {
    let found = 0
    for (let d = 0; d < 40; d += 4) if (c.kind[CO.mod(idx + d, c.n)] === want) { found = 1; break }
    out.push(found)
  }
  return out
}

// --- 学習なしの運転者 ---------------------------------------------------------

const HEUR_MARGIN = 0.85 // グリップの限界の何割まで攻めるか

/**
 * 学習なしの運転者。先の中心線へ向かってステアを切り、コーナーの手前で減速する。
 * skill を下げると狙う速度が落ちて弱くなる。戻り値: [throttle, steer, jump]
 */
export function heuristicAction(s: State, car: Car, c: CO.Course,
                                skill = 1.0): [number, number, number] {
  const idx = Math.trunc(s.seg)
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
  const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw)
  const vlong = s.vx * fx + s.vz * fz

  const look = clamp(10 + vlong * 0.75, 12, 46)
  const j = CO.mod(idx + Math.round(look / c.spacing), c.n)
  const dx = c.x[j] - s.x, dz = c.z[j] - s.z
  const side = dx * rx + dz * rz
  const front = Math.max(dx * fx + dz * fz, 1)
  let steer = clamp(Math.atan2(side, front) * 2.2, -1, 1)

  const a = CO.mod(idx + Math.round(20 / c.spacing), c.n)
  const b = CO.mod(idx + Math.round(70 / c.spacing), c.n)
  const swing = Math.abs(CO.wrapAngle(c.heading[b] - c.heading[a]))
  const radius = 50 / Math.max(swing, 1e-3)
  // 曲がれる限界は step() と同じ式で見積もる（ここがずれるとコーナーで膨らむ）
  const latAccel = (LAT_BASE + LAT_PER_GRIP * car.grip) * HEUR_MARGIN
  const top = car.vmax * (s.boost > 0 ? BOOST_VMAX : 1)
  const want = Math.min(Math.sqrt(latAccel * radius), top) * skill
  let throttle = clamp((want - vlong) * 0.35, -1, 1)

  // 空中では、着地に向けて車の向きをコースの向きへ戻す
  if (s.on_ground < 0.5) {
    steer = clamp(-CO.wrapAngle(c.heading[idx] - s.yaw) * 2, -1, 1)
    throttle = 1
  }

  const gapSoon = c.kind[CO.mod(idx + Math.round(6 / c.spacing), c.n)] === CO.KIND_GAP
  const jump = gapSoon && s.on_ground > 0.5 ? 1 : -1
  return [throttle, steer, jump]
}

// --- 車の一覧（shared/cars/*.json をそのまま読む）-------------------------------

const CAR_FILES = import.meta.glob<Car>('../../../../../shared/cars/*.json', {
  eager: true, import: 'default',
})

/** ファイル名順の車の一覧 */
export const CARS: Car[] = Object.entries(CAR_FILES)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([, v]) => v)

export const carIds = () => CARS.map((c) => c.id)

export function loadCar(id: string): Car {
  const car = CARS.find((c) => c.id === id)
  if (!car) throw new Error(`車 '${id}' がありません`)
  return car
}
