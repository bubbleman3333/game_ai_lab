// 車 1 台の運動と、建物・小物・ほかの車との衝突。three.js に依存しない。
//
// タイヤの横の力で曲がる「二輪モデル（自転車モデル）」を使っている。
//   前輪・後輪それぞれの横滑りの角度（スリップ角）から横の力を出し、
//   それがグリップの限界（μ × 荷重）を超えないように頭打ちにする。
// だから速すぎるとアンダーステアで膨らみ、サイドブレーキで後輪のグリップを落とすとお尻が流れる（ドリフト）。
// 低速ではこの式が不安定になるので、タイヤが滑らない「幾何学的な曲がり方」に混ぜている。
//
// 向きの決まりはレースと同じ（games/racer/README.md の「向きの決まり」）:
//   前 = (sin yaw, cos yaw)、運転者から見た右 = (−cos yaw, sin yaw)。右に曲がると yaw は減る。
//   steer は +1 が右。

import type { CityMap } from './cityMap'
import { CURB_HEIGHT } from './cityMap'

export const G = 9.81
/** この速さ（m/s、約 58km/h）より速く護岸に突っ込むと、乗り越えて海へ落ちる */
export const WALL_JUMP = 16

export type VehicleType = 'sport' | 'sedan' | 'hatch' | 'taxi' | 'van' | 'suv' | 'police'

export interface VehicleSpec {
  type: VehicleType
  name: string
  mass: number
  /** 車体の長さ・幅・高さ（当たり判定と見た目の目安） */
  length: number
  width: number
  /** 重心から前輪・後輪までの距離 */
  a: number
  b: number
  /** 駆動力の最大（N）と最高速（m/s） */
  engine: number
  vmax: number
  /** ブレーキの減速度（m/s²） */
  brake: number
  /** タイヤの摩擦係数とコーナリングの硬さ（N/rad） */
  mu: number
  cf: number
  cr: number
  /** ハンドルを切れる最大の角度（rad）と、速度で切れ角を減らす目安の速さ */
  steerMax: number
  steerFade: number
  /** 耐久力 */
  hp: number
  wheelRadius: number
}

const spec = (s: Omit<VehicleSpec, 'cf' | 'cr'> & { stiff?: number }): VehicleSpec => {
  const stiff = s.stiff ?? 1
  return { ...s, cf: s.mass * 52 * stiff, cr: s.mass * 58 * stiff }
}

export const SPECS: Record<VehicleType, VehicleSpec> = {
  sport: spec({ type: 'sport', name: 'スポーツカー', mass: 1350, length: 4.4, width: 1.95, a: 1.25, b: 1.35,
                engine: 11500, vmax: 64, brake: 10.5, mu: 1.12, steerMax: 0.6, steerFade: 26, hp: 100, wheelRadius: 0.36, stiff: 1.1 }),
  sedan: spec({ type: 'sedan', name: 'セダン', mass: 1450, length: 4.7, width: 1.85, a: 1.3, b: 1.45,
                engine: 7600, vmax: 50, brake: 9, mu: 0.98, steerMax: 0.58, steerFade: 22, hp: 110, wheelRadius: 0.34 }),
  hatch: spec({ type: 'hatch', name: 'コンパクトカー', mass: 1100, length: 3.95, width: 1.72, a: 1.1, b: 1.25,
                engine: 5600, vmax: 45, brake: 9, mu: 0.95, steerMax: 0.62, steerFade: 20, hp: 85, wheelRadius: 0.32 }),
  taxi: spec({ type: 'taxi', name: 'タクシー', mass: 1500, length: 4.7, width: 1.8, a: 1.3, b: 1.45,
               engine: 7000, vmax: 48, brake: 9, mu: 0.97, steerMax: 0.58, steerFade: 22, hp: 115, wheelRadius: 0.34 }),
  van: spec({ type: 'van', name: 'バン', mass: 2300, length: 5.2, width: 2.0, a: 1.5, b: 1.6,
              engine: 9000, vmax: 40, brake: 7.5, mu: 0.88, steerMax: 0.55, steerFade: 18, hp: 160, wheelRadius: 0.38, stiff: 0.95 }),
  suv: spec({ type: 'suv', name: 'SUV', mass: 2000, length: 4.8, width: 1.95, a: 1.35, b: 1.5,
              engine: 10000, vmax: 52, brake: 8.5, mu: 0.95, steerMax: 0.56, steerFade: 22, hp: 140, wheelRadius: 0.4 }),
  police: spec({ type: 'police', name: 'パトカー', mass: 1600, length: 4.8, width: 1.88, a: 1.32, b: 1.46,
                 engine: 11500, vmax: 60, brake: 10, mu: 1.1, steerMax: 0.6, steerFade: 25, hp: 150, wheelRadius: 0.35, stiff: 1.1 }),
}

export interface Controls {
  /** −1〜1。正でアクセル、負でブレーキ（止まっていればバック） */
  throttle: number
  /** −1〜1。+1 が右 */
  steer: number
  handbrake: boolean
}

export const NO_CONTROLS: Controls = { throttle: 0, steer: 0, handbrake: false }

/** 車の状態（位置・速度・向き・見た目用の値） */
export interface Body {
  x: number
  z: number
  yaw: number
  vx: number
  vz: number
  /** 向きの変わる速さ（rad/s）。正で左回り */
  r: number
  /** 実際の前輪の切れ角（rad） */
  steer: number
  /** 見た目用: 車体の高さ（縁石に乗ると上がる）、前後・左右の加速度（車体の傾きに使う） */
  y: number
  accLong: number
  accLat: number
  wheelSpin: number
  /** 後輪の横滑りの速さ（m/s）。タイヤ痕と音に使う */
  slip: number
}

export function newBody(x: number, z: number, yaw: number): Body {
  return { x, z, yaw, vx: 0, vz: 0, r: 0, steer: 0, y: 0, accLong: 0, accLat: 0, wheelSpin: 0, slip: 0 }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export const forwardSpeed = (b: Body) => b.vx * Math.sin(b.yaw) + b.vz * Math.cos(b.yaw)
export const speedOf = (b: Body) => Math.hypot(b.vx, b.vz)

/** 慣性モーメント（長方形の板とみなす） */
export const inertia = (s: VehicleSpec) => (s.mass * (s.length * s.length + s.width * s.width)) / 12

/** 物理を 1 ステップ進める（dt は 1/120 秒程度の小さな値を想定） */
export function stepVehicle(b: Body, s: VehicleSpec, c: Controls, dt: number): void {
  const sin = Math.sin(b.yaw)
  const cos = Math.cos(b.yaw)
  const fx = sin, fz = cos // 前
  const rx = -cos, rz = sin // 右
  const vf = b.vx * fx + b.vz * fz
  const vl = b.vx * rx + b.vz * rz
  const speed = Math.hypot(vf, vl)
  const m = s.mass
  const L = s.a + s.b

  // ハンドル: 速いほど切れ角を小さくする。いっぱいに切ったとき、ちょうどグリップの限界（約 1.4G）で
  // 曲がれる角度になるように、速さの 2 乗で減らす（高速で急に切ってスピンしないように）
  const fade = Math.min(s.steerFade, Math.sqrt(((s.a + s.b) * 1.4 * s.mu * G) / s.steerMax))
  // サイドブレーキ中は大きく切れる（お尻を流してドリフトに持ち込めるように）
  const f2 = c.handbrake ? fade * 2.4 : fade
  const maxSteer = s.steerMax / (1 + (speed * speed) / (f2 * f2))
  const target = clamp(c.steer, -1, 1) * maxSteer
  b.steer += clamp(target - b.steer, -3.2 * dt, 3.2 * dt)
  const d = b.steer

  // --- 前後の力 ---
  let drive = 0
  let brake = 0 // 大きさだけ。向きは速度と逆
  const t = clamp(c.throttle, -1, 1)
  if (t > 0) {
    if (vf < -0.8) brake += s.brake * m * t
    else drive = s.engine * t * Math.max(0, 1 - (Math.max(vf, 0) / s.vmax) ** 2)
  } else if (t < 0) {
    if (vf > 0.8) brake += s.brake * m * -t
    else drive = s.engine * 0.55 * t * Math.max(0, 1 - (Math.max(-vf, 0) / 12) ** 2) // バック
  }
  const Nf = (m * G * s.b) / L
  const Nr = (m * G * s.a) / L
  if (c.handbrake) brake += s.mu * Nr * 0.9
  drive = clamp(drive, -s.mu * m * G * 0.95, s.mu * m * G * 0.95)
  // 転がり抵抗・空気抵抗・エンジンブレーキ（アクセルを離すとじわっと減速する）
  const engineBrake = t === 0 ? -Math.sign(vf) * Math.min(Math.abs(vf) * m * 0.2, m * 0.9) : 0
  const resist = -m * 0.035 * vf - 0.42 * vf * Math.abs(vf) + engineBrake
  // ブレーキは止まるまでしか効かせない（止まったあと逆に進まないように）
  brake = Math.min(brake, (Math.abs(vf) * m) / dt)
  const Fx = drive + resist - Math.sign(vf) * brake

  // --- 横の力（スリップ角から） ---
  const vlf = vl - s.a * b.r
  const vlr = vl + s.b * b.r
  const cd = Math.cos(d), sd = Math.sin(d)
  const vfw = vf * cd + vlf * sd
  const vlw = -vf * sd + vlf * cd
  const af = Math.atan2(vlw, Math.abs(vfw) + 0.2)
  const ar = Math.atan2(vlr, Math.abs(vf) + 0.2)
  // アクセルを強く踏むと後輪の横グリップが減る（摩擦円）。サイドブレーキではもっと減る
  // 後輪は少しだけグリップを多めにして、限界では前から滑る（アンダーステア＝素直な）車にする
  const rearUse = c.handbrake ? 0.62 : Math.min(Math.abs(drive) / (s.mu * Nr), 1) * 0.18
  const muR = s.mu * 1.08 * (1 - rearUse)
  const Ff = clamp(-s.cf * af, -s.mu * Nf, s.mu * Nf)
  const Fr = clamp(-s.cr * ar, -muR * Nr, muR * Nr)

  const Flong = Fx - Ff * sd
  const Flat = Fr + Ff * cd
  const torque = -s.a * Ff * cd + s.b * Fr
  const I = inertia(s)

  b.vx += ((Flong * fx + Flat * rx) / m) * dt
  b.vz += ((Flong * fz + Flat * rz) / m) * dt
  b.r += (torque / I) * dt
  b.accLong = Flong / m
  b.accLat = Flat / m

  // 横滑り防止（ESC のようなもの）: サイドブレーキを引いていなければ、向きの変わる速さを
  // 「前輪が向いている方向に曲がる速さ」へ少しずつ寄せる。キーボードでも車を立て直せるように
  if (!c.handbrake && speed > 3) {
    const vfNow = b.vx * fx + b.vz * fz
    const limit = (s.mu * G * 1.3) / speed
    const rWant = Math.max(-limit, Math.min(limit, (-vfNow * Math.tan(d)) / L))
    b.r += (rWant - b.r) * (1 - Math.exp(-dt * 2.2))
  }

  // 低速: タイヤが滑らない曲がり方に寄せる（止まりかけで向きがぶるぶるしないように）
  const w = clamp((speed - 1.5) / 3.5, 0, 1)
  if (w < 1) {
    const vf2 = b.vx * fx + b.vz * fz
    const vl2 = (b.vx * rx + b.vz * rz) * w
    const rKin = (-vf2 * Math.tan(d)) / L
    b.r = rKin + (b.r - rKin) * w
    b.vx = fx * vf2 + rx * vl2
    b.vz = fz * vf2 + rz * vl2
  }
  // 何も踏んでいなくて、ほぼ止まっているならぴたっと止める
  if (t === 0 && speed < 0.35) { b.vx *= 0.8; b.vz *= 0.8; b.r *= 0.8 }

  b.yaw += b.r * dt
  b.x += b.vx * dt
  b.z += b.vz * dt
  b.wheelSpin += (vf / s.wheelRadius) * dt * (c.handbrake ? 0 : 1)
  b.slip = Math.abs(vlr) + (c.handbrake && Math.abs(vf) > 3 ? 4 : 0)
}

// --- 衝突 ----------------------------------------------------------------------

/** 車体を「前後に並んだ 3 つの円」とみなす。箱どうしの判定より軽くて、角でひっかからない */
export function circles(b: Body, s: VehicleSpec, out: [number, number][] = [[0, 0], [0, 0], [0, 0]]): [number, number][] {
  const rad = s.width / 2
  const o = s.length / 2 - rad
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw)
  out[0][0] = b.x - fx * o; out[0][1] = b.z - fz * o
  out[1][0] = b.x; out[1][1] = b.z
  out[2][0] = b.x + fx * o; out[2][1] = b.z + fz * o
  return out
}

export interface WorldHit {
  /** ぶつかった速さ（m/s、壁に向かう向きの成分） */
  impact: number
  x: number
  z: number
  /** 倒した小物の番号（倒していなければ −1） */
  brokeProp: number
}

const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx

/** 位置 (cx, cz) の点に、法線 n 向きの力積を与えて跳ね返す。戻り値はぶつかった速さ */
function bounce(b: Body, s: VehicleSpec, cx: number, cz: number, nx: number, nz: number, e: number): number {
  const rcx = cx - b.x, rcz = cz - b.z
  const vcx = b.vx + b.r * rcz
  const vcz = b.vz - b.r * rcx
  const vn = vcx * nx + vcz * nz
  if (vn >= 0) return 0
  const I = inertia(s)
  const cn = cross(rcx, rcz, nx, nz)
  const j = (-(1 + e) * vn) / (1 / s.mass + (cn * cn) / I)
  // 接線方向の摩擦（壁をこすると減速する）
  const tx = -nz, tz = nx
  const vt = vcx * tx + vcz * tz
  const ct = cross(rcx, rcz, tx, tz)
  const jt = clamp(-vt / (1 / s.mass + (ct * ct) / I), -0.35 * j, 0.35 * j)
  const Jx = nx * j + tx * jt, Jz = nz * j + tz * jt
  b.vx += Jx / s.mass
  b.vz += Jz / s.mass
  b.r -= cross(rcx, rcz, Jx, Jz) / I
  return -vn
}

const tmpB: number[] = []
const tmpP: number[] = []
const circ: [number, number][] = [[0, 0], [0, 0], [0, 0]]

/**
 * 建物・護岸・小物との衝突を解く。
 * broken[i] が 1 の小物（倒れた街灯）は通り抜ける。倒せる小物に強く当たると倒す。
 */
export function collideWorld(b: Body, s: VehicleSpec, map: CityMap, broken: Uint8Array): WorldHit | null {
  const rad = s.width / 2
  map.near(b.x, b.z, s.length / 2 + 2, tmpB, tmpP)
  let hit: WorldHit | null = null
  const boxes = tmpB.map((i) => map.buildings[i] as { x0: number; z0: number; x1: number; z1: number })
  const nBuildings = boxes.length
  for (const w of map.walls) {
    if (b.x > w.x0 - 6 && b.x < w.x1 + 6 && b.z > w.z0 - 6 && b.z < w.z1 + 6) boxes.push(w)
  }
  for (let pass = 0; pass < 2; pass++) {
    circles(b, s, circ)
    for (const [cx, cz] of circ) {
      for (let bi = 0; bi < boxes.length; bi++) {
        const B = boxes[bi]
        const px = clamp(cx, B.x0, B.x1)
        const pz = clamp(cz, B.z0, B.z1)
        let nx = cx - px, nz = cz - pz
        let dist = Math.hypot(nx, nz)
        let pen: number
        if (dist === 0) {
          // 円の中心が箱の中: いちばん近い面から押し出す
          const dl = cx - B.x0, dr = B.x1 - cx, dd = cz - B.z0, du = B.z1 - cz
          const mn = Math.min(dl, dr, dd, du)
          if (mn === dl) { nx = -1; nz = 0 } else if (mn === dr) { nx = 1; nz = 0 }
          else if (mn === dd) { nx = 0; nz = -1 } else { nx = 0; nz = 1 }
          pen = mn + rad
          dist = 1
        } else {
          if (dist >= rad) continue
          nx /= dist; nz /= dist
          pen = rad - dist
        }
        // 護岸（腰の高さの壁）は、速く突っ込めば乗り越えて海へ落ちる
        if (bi >= nBuildings && -(b.vx * nx + b.vz * nz) > WALL_JUMP) continue
        b.x += nx * pen
        b.z += nz * pen
        const imp = bounce(b, s, cx - nx * rad, cz - nz * rad, nx, nz, 0.25)
        if (imp > 0 && (!hit || imp > hit.impact)) hit = { impact: imp, x: cx - nx * rad, z: cz - nz * rad, brokeProp: -1 }
      }
      for (const pi of tmpP) {
        if (broken[pi]) continue
        const p = map.props[pi]
        let nx = cx - p.x, nz = cz - p.z
        const dist = Math.hypot(nx, nz)
        const min = rad + p.r
        if (dist >= min || dist === 0) continue
        nx /= dist; nz /= dist
        const vn = b.vx * nx + b.vz * nz
        if (p.breakable && -vn > 2.5) {
          // 街灯をなぎ倒す: 止まらずに少しだけ減速する
          broken[pi] = 1
          b.vx *= 0.9; b.vz *= 0.9
          hit = { impact: -vn * 0.4, x: p.x, z: p.z, brokeProp: pi }
          continue
        }
        b.x += nx * (min - dist)
        b.z += nz * (min - dist)
        const imp = bounce(b, s, p.x + nx * p.r, p.z + nz * p.r, nx, nz, 0.2)
        if (imp > 0 && (!hit || imp > hit.impact)) hit = { impact: imp, x: p.x, z: p.z, brokeProp: -1 }
      }
    }
  }
  // 縁石: 歩道に乗ると車体が少し上がる（見た目だけ）
  const surf = map.surface(b.x, b.z)
  const targetY = surf === 'sidewalk' ? CURB_HEIGHT : 0
  b.y += (targetY - b.y) * 0.35
  return hit
}

const ca: [number, number][] = [[0, 0], [0, 0], [0, 0]]
const cb: [number, number][] = [[0, 0], [0, 0], [0, 0]]

/** 2 台が重なっているか（安い判定。先に調べて、車線を走っている車を物理に切り替えるのに使う） */
export function overlapping(A: Body, sa: VehicleSpec, B: Body, sb: VehicleSpec): boolean {
  const reach = (sa.length + sb.length) / 2
  const dx = A.x - B.x, dz = A.z - B.z
  if (dx * dx + dz * dz > reach * reach) return false
  circles(A, sa, ca)
  circles(B, sb, cb)
  const min = (sa.width + sb.width) / 2
  for (const [ax, az] of ca) for (const [bx, bz] of cb) {
    if ((ax - bx) ** 2 + (az - bz) ** 2 < min * min) return true
  }
  return false
}

/** 車どうしの衝突。戻り値はぶつかった速さ（重なっていなければ 0） */
export function collideVehicles(A: Body, sa: VehicleSpec, B: Body, sb: VehicleSpec): { impact: number; x: number; z: number } {
  const reach = (sa.length + sb.length) / 2
  const dx0 = A.x - B.x, dz0 = A.z - B.z
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return { impact: 0, x: 0, z: 0 }
  circles(A, sa, ca)
  circles(B, sb, cb)
  const ra = sa.width / 2, rb = sb.width / 2
  let best = 0, hx = 0, hz = 0
  const Ia = inertia(sa), Ib = inertia(sb)
  for (const [ax, az] of ca) for (const [bx, bz] of cb) {
    let nx = ax - bx, nz = az - bz
    const dist = Math.hypot(nx, nz)
    if (dist >= ra + rb || dist === 0) continue
    nx /= dist; nz /= dist
    const pen = ra + rb - dist
    const wa = sb.mass / (sa.mass + sb.mass)
    A.x += nx * pen * wa; A.z += nz * pen * wa
    B.x -= nx * pen * (1 - wa); B.z -= nz * pen * (1 - wa)
    const px = bx + nx * rb, pz = bz + nz * rb
    const rax = px - A.x, raz = pz - A.z
    const rbx = px - B.x, rbz = pz - B.z
    const vax = A.vx + A.r * raz, vaz = A.vz - A.r * rax
    const vbx = B.vx + B.r * rbz, vbz = B.vz - B.r * rbx
    const vn = (vax - vbx) * nx + (vaz - vbz) * nz
    if (vn >= 0) continue
    const cna = cross(rax, raz, nx, nz)
    const cnb = cross(rbx, rbz, nx, nz)
    const j = (-(1 + 0.3) * vn) / (1 / sa.mass + 1 / sb.mass + (cna * cna) / Ia + (cnb * cnb) / Ib)
    A.vx += (nx * j) / sa.mass; A.vz += (nz * j) / sa.mass
    B.vx -= (nx * j) / sb.mass; B.vz -= (nz * j) / sb.mass
    A.r -= cross(rax, raz, nx * j, nz * j) / Ia
    B.r += cross(rbx, rbz, nx * j, nz * j) / Ib
    if (-vn > best) { best = -vn; hx = px; hz = pz }
  }
  return { impact: best, x: hx, z: hz }
}
