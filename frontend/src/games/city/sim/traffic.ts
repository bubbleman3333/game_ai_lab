// 街を走る一般の車（NPC）の運転。車線の上を決まった線どおりに進む（物理は使わない）。
//
//   直線  交差点 A を出てから、次の交差点 B の手前まで。左側の車線を走る
//   カーブ 交差点 B の中。二次ベジェ曲線で次の道の車線へつなぐ
//
// 交差点に近づいたら、次にどちらへ曲がるかを決めて車線を寄せておく
// （左折は外側＝歩道側の車線、右折は内側の車線）。
// 信号が赤・黄なら停止線で止まり、前に車や人がいれば車間を空けて止まる。
//
// ぶつけられたら、この運転をやめて物理（vehicle.ts）で動く「ただの車」になる（game.ts が切り替える）。

import {
  CityMap, DIRS, LANE_OFFSETS, NODES, PITCH, ROAD_HALF, STOP_DIST, leftOf, nodeX,
} from './cityMap'
import type { Body } from './vehicle'
import type { Rng } from './rng'

const STRAIGHT_LEN = PITCH - 2 * ROAD_HALF
const STOP_S = STRAIGHT_LEN - (STOP_DIST - ROAD_HALF) // 直線の中の停止線の位置
const ACCEL = 2.6
const DECEL = 6.5

export const leftTurn = (d: number) => (d + 3) % 4
export const rightTurn = (d: number) => (d + 1) % 4
const inGrid = (i: number, j: number) => i >= 0 && j >= 0 && i < NODES && j < NODES

/** 前にあるもの（車・人）。game.ts が毎フレーム渡す */
export interface Obstacle {
  x: number; z: number; vx: number; vz: number
  /** 横幅の半分と、前後の長さの半分 */
  radius: number
  half: number
  self?: boolean
}

export class LaneDriver {
  kind: 'straight' | 'turn' = 'straight'
  /** 向かっている交差点 */
  i: number
  j: number
  dir: number
  nextDir: number
  lane: number
  laneOff: number
  s: number
  len = STRAIGHT_LEN
  speed: number
  cruise: number
  /** 前がふさがれて止まっている時間（クラクションを鳴らす目安） */
  blocked = 0
  /** 自分の車の長さの半分（車間の計算に使う。game.ts が車種に合わせて入れる） */
  halfLen = 2.3
  // カーブの制御点
  private p = [0, 0, 0, 0, 0, 0]
  private turnSpeed = 6

  constructor(i: number, j: number, dir: number, s: number, lane: number, rng: Rng) {
    this.i = i
    this.j = j
    this.dir = dir
    this.s = s
    this.lane = lane
    this.laneOff = LANE_OFFSETS[lane]
    this.cruise = 11.5 + rng() * 4
    this.speed = this.cruise * 0.8
    this.nextDir = this.plan(rng)
  }

  /** 次の交差点でどちらへ行くか決め、そのための車線を選ぶ */
  private plan(rng: Rng): number {
    const opts: [number, number][] = []
    for (const [d, w] of [[this.dir, 0.55], [leftTurn(this.dir), 0.22], [rightTurn(this.dir), 0.23]] as [number, number][]) {
      const [dx, dz] = DIRS[d]
      if (inGrid(this.i + dx, this.j + dz)) opts.push([d, w])
    }
    if (opts.length === 0) opts.push([(this.dir + 2) % 4, 1])
    const total = opts.reduce((a, o) => a + o[1], 0)
    let r = rng() * total
    let next = opts[0][0]
    for (const [d, w] of opts) { if ((r -= w) <= 0) { next = d; break } }
    if (next === leftTurn(this.dir)) this.lane = 1
    else if (next === rightTurn(this.dir)) this.lane = 0
    return next
  }

  /** 今いる直線の始まり（前の交差点を出たところ） */
  private straightStart(): [number, number] {
    const [dx, dz] = DIRS[this.dir]
    return [nodeX(this.i) - dx * (PITCH - ROAD_HALF), nodeX(this.j) - dz * (PITCH - ROAD_HALF)]
  }

  private beginTurn(): void {
    const [dx, dz] = DIRS[this.dir]
    const [ex, ez] = DIRS[this.nextDir]
    const [lx, lz] = leftOf(dx, dz)
    const [mx, mz] = leftOf(ex, ez)
    const cx = nodeX(this.i), cz = nodeX(this.j)
    const outLane = this.nextDir === this.dir ? this.lane : this.nextDir === leftTurn(this.dir) ? 1 : 0
    const p0x = cx - dx * ROAD_HALF + lx * this.laneOff
    const p0z = cz - dz * ROAD_HALF + lz * this.laneOff
    const p2x = cx + ex * ROAD_HALF + mx * LANE_OFFSETS[outLane]
    const p2z = cz + ez * ROAD_HALF + mz * LANE_OFFSETS[outLane]
    let p1x: number, p1z: number
    if (this.nextDir === this.dir || this.nextDir === (this.dir + 2) % 4) {
      p1x = (p0x + p2x) / 2; p1z = (p0z + p2z) / 2
      if (this.nextDir !== this.dir) { p1x = cx + dx * ROAD_HALF * 1.5; p1z = cz + dz * ROAD_HALF * 1.5 } // U ターン
    } else {
      // 2 本の車線の延長線が交わる点を角にする
      const k = (p2x - p0x) * dx + (p2z - p0z) * dz
      p1x = p0x + dx * k; p1z = p0z + dz * k
    }
    this.p = [p0x, p0z, p1x, p1z, p2x, p2z]
    let len = 0
    let [qx, qz] = [p0x, p0z]
    for (let k = 1; k <= 8; k++) {
      const [x, z] = this.bezier(k / 8)
      len += Math.hypot(x - qx, z - qz)
      qx = x; qz = z
    }
    this.len = len
    this.lane = outLane
    this.turnSpeed = this.nextDir === this.dir ? this.cruise : this.nextDir === leftTurn(this.dir) ? 5.2 : 7
    this.kind = 'turn'
    this.s = 0
  }

  private bezier(t: number): [number, number] {
    const [ax, az, bx, bz, cx, cz] = this.p
    const u = 1 - t
    return [u * u * ax + 2 * u * t * bx + t * t * cx, u * u * az + 2 * u * t * bz + t * t * cz]
  }

  private endTurn(rng: Rng): void {
    this.dir = this.nextDir
    const [dx, dz] = DIRS[this.dir]
    this.i += dx
    this.j += dz
    this.kind = 'straight'
    this.s = 0
    this.len = STRAIGHT_LEN
    this.laneOff = LANE_OFFSETS[this.lane]
    this.nextDir = this.plan(rng)
  }

  /** 今の位置と向き */
  pose(): [number, number, number] {
    if (this.kind === 'straight') {
      const [dx, dz] = DIRS[this.dir]
      const [lx, lz] = leftOf(dx, dz)
      const [sx, sz] = this.straightStart()
      // 車線を変えている途中は、少し斜めを向く
      const target = LANE_OFFSETS[this.lane]
      const drift = Math.sign(target - this.laneOff) * Math.min(Math.abs(target - this.laneOff), 1) * 0.12
      return [sx + dx * this.s + lx * this.laneOff, sz + dz * this.s + lz * this.laneOff,
              Math.atan2(dx, dz) + drift * (this.speed > 1 ? 1 : 0)]
    }
    const t = Math.min(this.s / this.len, 1)
    const [x, z] = this.bezier(t)
    const [x2, z2] = this.bezier(Math.min(t + 0.02, 1))
    const [x1, z1] = t >= 0.98 ? this.bezier(0.96) : [x, z]
    const yaw = t >= 0.98 ? Math.atan2(x - x1, z - z1) : Math.atan2(x2 - x, z2 - z)
    return [x, z, yaw]
  }

  /** 前方 range m のうちで、いちばん近いものまでの距離 */
  private gapAhead(x: number, z: number, yaw: number, obstacles: Obstacle[], range: number): number {
    const fx = Math.sin(yaw), fz = Math.cos(yaw)
    let gap = Infinity
    for (const o of obstacles) {
      if (o.self) continue
      const rx = o.x - x, rz = o.z - z
      const along = rx * fx + rz * fz
      if (along <= 0 || along > range) continue
      const side = Math.abs(rx * -fz + rz * fx)
      if (side > 1.3 + o.radius) continue
      gap = Math.min(gap, along - this.halfLen - o.half - 1.2)
    }
    return gap
  }

  /** 車線を変える先の横が空いているか */
  private laneClear(x: number, z: number, target: number, obstacles: Obstacle[]): boolean {
    const [dx, dz] = DIRS[this.dir]
    const [lx, lz] = leftOf(dx, dz)
    const cx = nodeX(this.i), cz = nodeX(this.j)
    const lo = Math.min(this.laneOff, target) - 1.2
    const hi = Math.max(this.laneOff, target) + 1.2
    for (const o of obstacles) {
      if (o.self) continue
      const along = (o.x - x) * dx + (o.z - z) * dz
      if (Math.abs(along) > this.halfLen + o.half + 2) continue
      const off = (o.x - cx) * lx + (o.z - cz) * lz
      if (off > lo && off < hi && Math.abs(off - this.laneOff) > 0.8) return false
    }
    return true
  }

  /** 右折のとき: 対向車が来ていれば交差点の入口で待つ */
  private oncomingClear(obstacles: Obstacle[]): boolean {
    const [dx, dz] = DIRS[this.dir]
    const cx = nodeX(this.i), cz = nodeX(this.j)
    for (const o of obstacles) {
      if (o.self) continue
      const rx = o.x - cx, rz = o.z - cz
      const along = rx * dx + rz * dz // 対向車は交差点の向こう側（along > 0）から、こちらへ向かってくる
      const side = rx * -dz + rz * dx
      if (along < 2 || along > 45 || Math.abs(side) > ROAD_HALF) continue
      const vin = -(o.vx * dx + o.vz * dz)
      if (vin > 2) return false
    }
    return true
  }

  /** 1 フレーム進める。body に位置・速度・向きを書き込む */
  update(dt: number, time: number, obstacles: Obstacle[], rng: Rng, body: Body): void {
    const [x, z, yaw] = this.pose()
    let want = this.kind === 'turn' ? this.turnSpeed : this.cruise
    let gap = this.gapAhead(x, z, yaw, obstacles, 34)

    if (this.kind === 'straight') {
      // 曲がる前は曲がれる速さまで落とす
      const turning = this.nextDir !== this.dir
      const toEnd = this.len - this.s
      if (turning) want = Math.min(want, Math.sqrt(6 * 6 + 2 * 2.5 * Math.max(toEnd - 4, 0)))
      // 信号
      const axis: 0 | 1 = DIRS[this.dir][0] !== 0 ? 0 : 1
      const light = CityMap.light(this.i, this.j, axis, time)
      const toStop = STOP_S - this.s
      if (light !== 'green' && toStop > -0.5) {
        const canStop = (this.speed * this.speed) / (2 * DECEL * 0.8) < toStop + 0.5
        if (light === 'red' || canStop) gap = Math.min(gap, toStop)
      }
      // 右折は対向車を待つ
      if (this.nextDir === rightTurn(this.dir) && !this.oncomingClear(obstacles)) {
        gap = Math.min(gap, toEnd - 0.5)
      }
      // 車線を寄せる（寄せる先の横に車がいたら待つ）
      const target = LANE_OFFSETS[this.lane]
      if (Math.abs(target - this.laneOff) > 0.01 && this.laneClear(x, z, target, obstacles)) {
        this.laneOff += Math.sign(target - this.laneOff) * Math.min(Math.abs(target - this.laneOff), 1.6 * dt * Math.min(this.speed / 5, 1))
      }
    }

    // 止まりたい場所までに止まれる速さ（v² = 2ad）
    if (gap < Infinity) want = Math.min(want, Math.sqrt(2 * DECEL * 0.7 * Math.max(gap - 0.5, 0)))
    if (want < this.speed) this.speed = Math.max(want, this.speed - DECEL * dt * 1.5)
    else this.speed = Math.min(want, this.speed + ACCEL * dt)
    if (this.speed < 0.05 && want < 0.05) this.speed = 0
    this.blocked = this.speed < 0.5 && gap < 6 ? this.blocked + dt : 0

    this.s += this.speed * dt
    if (this.s >= this.len) {
      if (this.kind === 'straight') this.beginTurn()
      else this.endTurn(rng)
    }

    const [nx, nz, nyaw] = this.pose()
    let dyaw = nyaw - body.yaw
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
    body.x = nx
    body.z = nz
    body.yaw = body.yaw + dyaw
    body.vx = Math.sin(nyaw) * this.speed
    body.vz = Math.cos(nyaw) * this.speed
    body.r = dt > 0 ? dyaw / dt : 0
    body.steer = this.speed > 0.5 ? Math.max(-0.5, Math.min(0.5, -(body.r * 2.7) / this.speed)) : body.steer
    body.accLong = 0
    body.accLat = 0
    body.slip = 0
    body.y = 0
  }
}

/** 車線の上のランダムな場所（中心 (x, z) から min〜max m）。見つからなければ null */
export function randomLaneSpot(rng: Rng, x: number, z: number, min: number, max: number): LaneDriver | null {
  const reach = Math.ceil(max / PITCH) + 1
  const ci = Math.round((x - nodeX(0)) / PITCH)
  const cj = Math.round((z - nodeX(0)) / PITCH)
  for (let tries = 0; tries < 30; tries++) {
    const dir = Math.floor(rng() * 4)
    const [dx, dz] = DIRS[dir]
    const i = ci + Math.floor(rng() * (2 * reach + 1)) - reach
    const j = cj + Math.floor(rng() * (2 * reach + 1)) - reach
    if (!inGrid(i, j)) continue
    if (!inGrid(i - dx, j - dz)) continue
    const s = 4 + rng() * (STOP_S - 20)
    const px = nodeX(i) - dx * (PITCH - ROAD_HALF - s)
    const pz = nodeX(j) - dz * (PITCH - ROAD_HALF - s)
    const dist = Math.hypot(px - x, pz - z)
    if (dist < min || dist > max) continue
    return new LaneDriver(i, j, dir, s, rng() < 0.5 ? 0 : 1, rng)
  }
  return null
}
