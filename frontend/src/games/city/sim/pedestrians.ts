// 通行人。歩道を区画に沿ってぐるぐる歩き、角に来たらときどき横断歩道を渡る（歩行者用の信号を守る）。
// 危ない車が近づいたり、クラクションや衝突・爆発があったりすると逃げ出す。
// 車にはねられると宙を舞って倒れる（fly → down）。three.js には依存しない。
//
// 歩道の輪: 区画の中心から SIDEWALK_MID(+ずれ) の正方形。周の上の位置 t（0〜8S）で表す。
//   辺 0: z = cz − S を +x へ  / 辺 1: x = cx + S を +z へ / 辺 2: z = cz + S を −x へ / 辺 3: x = cx − S を −z へ

import { BLOCKS, CityMap, PITCH, SIDEWALK_MID, blockCenter } from './cityMap'
import { pick, range, type Rng } from './rng'

export type PedMode = 'walk' | 'wait' | 'cross' | 'flee' | 'return' | 'fly' | 'down' | 'stagger' | 'officer'

export interface PedLook {
  height: number
  width: number
  skin: number
  hair: number
  shirt: number
  pants: number
  shoes: number
  /** 0: 短髪 1: 長髪 2: 帽子 */
  hairStyle: number
  skirt: boolean
  shortSleeve: boolean
}

export interface Ped {
  id: number
  x: number
  z: number
  y: number
  yaw: number
  vx: number
  vy: number
  vz: number
  mode: PedMode
  walkSpeed: number
  // 歩道の輪の上
  bi: number
  bj: number
  t: number
  dirSign: number
  offset: number
  // 横断・戻り先
  tx: number
  tz: number
  crossTo: [number, number, number] // 渡った先の区画と t
  crossAxis: 0 | 1
  crossNode: [number, number]
  timer: number
  /** 歩き・走りの手足の振りの位相 */
  phase: number
  /** 倒れる角度（0 = 立っている、π/2 = 寝ている）と倒れる向き */
  tilt: number
  fallYaw: number
  spin: number
  look: PedLook
  /** 倒れてからの時間（血だまりの大きさ・消すタイミング） */
  downTime: number
  /**
   * パトカーから降りた警官なら、その車の番号と、今どうしているか
   *   out  … 目的の場所（運転席の窓・逃げた車のそば）へ向かう / そこで立っている
   *   back … パトカーへ戻る（着いたら乗り込んで消える）
   */
  officer: { car: number; phase: 'out' | 'back'; run: boolean; face: number } | null
}

/** 警官の制服（紺のシャツとズボン、制帽） */
const UNIFORM: PedLook = {
  height: 1, width: 1.05, skin: 0xe0ac80, hair: 0x1b1511, shirt: 0x243453, pants: 0x1a2338, shoes: 0x0e0e0e,
  hairStyle: 2, skirt: false, shortSleeve: false,
}

const SKINS = [0xf1c9a5, 0xe0ac80, 0xc68c5a, 0x8d5a3b, 0x5c3a24, 0xf5d7bd]
const HAIRS = [0x1b1511, 0x2e1f14, 0x5a3a22, 0x8a6a3a, 0xb8a27a, 0x6b6b6b, 0x9a3a1e]
const SHIRTS = [0xe8e8ea, 0x1d2a44, 0x8a1f24, 0x2f5d3a, 0xd9b44a, 0x3a6ea5, 0x5a4a6e, 0x2b2b2e, 0xc76a3a, 0x6fa3b8, 0xe39ab0]
const PANTS = [0x22262e, 0x2d3a55, 0x3b3226, 0x5b5f66, 0x1a1a1c, 0x6d5a44, 0x8a8f99]
const SHOES = [0x111111, 0x3a2a1c, 0xe8e8e8, 0x5a1a1a]

export function randomLook(rng: Rng): PedLook {
  return {
    height: range(rng, 0.9, 1.08),
    width: range(rng, 0.9, 1.12),
    skin: pick(rng, SKINS),
    hair: pick(rng, HAIRS),
    shirt: pick(rng, SHIRTS),
    pants: pick(rng, PANTS),
    shoes: pick(rng, SHOES),
    hairStyle: rng() < 0.55 ? 0 : rng() < 0.7 ? 1 : 2,
    skirt: rng() < 0.18,
    shortSleeve: rng() < 0.4,
  }
}

const S0 = SIDEWALK_MID
/** 角の t（(sx, sz) は区画の中心から見た角の向き） */
function cornerT(S: number, sx: number, sz: number): number {
  // 辺 k の終わりの角は t = 2S(k+1)
  const k = sx > 0 ? (sz < 0 ? 0 : 1) : sz > 0 ? 2 : 3
  return ((k + 1) * 2 * S) % (8 * S)
}

function ringPoint(cx: number, cz: number, S: number, t: number): [number, number, number] {
  const L = 8 * S
  t = ((t % L) + L) % L
  const k = Math.floor(t / (2 * S))
  const u = t - k * 2 * S - S
  switch (k) {
    case 0: return [cx + u, cz - S, Math.PI / 2]
    case 1: return [cx + S, cz + u, 0]
    case 2: return [cx - u, cz + S, -Math.PI / 2]
    default: return [cx - S, cz - u, Math.PI]
  }
}

/** 点を歩道の輪に近い位置へ寄せたときの t */
function nearestT(cx: number, cz: number, S: number, x: number, z: number): number {
  const lx = x - cx, lz = z - cz
  // 4 辺それぞれへの距離を比べる
  const cand: [number, number][] = [
    [Math.abs(lz + S), S + Math.max(-S, Math.min(S, lx))],
    [Math.abs(lx - S), 3 * S + Math.max(-S, Math.min(S, lz))],
    [Math.abs(lz - S), 5 * S + Math.max(-S, Math.min(S, -lx))],
    [Math.abs(lx + S), 7 * S + Math.max(-S, Math.min(S, -lz))],
  ]
  cand.sort((a, b) => a[0] - b[0])
  return cand[0][1]
}

export const isDown = (p: Ped) => p.mode === 'fly' || p.mode === 'down'

export class Pedestrians {
  readonly list: Ped[] = []
  private nextId = 1
  private map: CityMap
  private rng: Rng
  constructor(map: CityMap, rng: Rng) { this.map = map; this.rng = rng }

  ringHalf(p: Ped) { return S0 + p.offset }

  spawnNear(x: number, z: number, min: number, max: number): Ped | null {
    const rng = this.rng
    for (let tries = 0; tries < 12; tries++) {
      const bi = Math.floor((x + PITCH * BLOCKS / 2) / PITCH + (rng() - 0.5) * 2 * (max / PITCH + 1))
      const bj = Math.floor((z + PITCH * BLOCKS / 2) / PITCH + (rng() - 0.5) * 2 * (max / PITCH + 1))
      if (bi < 0 || bj < 0 || bi >= BLOCKS || bj >= BLOCKS) continue
      const offset = range(rng, -1.5, 1.4)
      const S = S0 + offset
      const t = rng() * 8 * S
      const [px, pz, yaw] = ringPoint(blockCenter(bi), blockCenter(bj), S, t)
      const d = Math.hypot(px - x, pz - z)
      if (d < min || d > max) continue
      const p: Ped = {
        id: this.nextId++, x: px, z: pz, y: 0, yaw, vx: 0, vy: 0, vz: 0, mode: 'walk',
        walkSpeed: range(rng, 1.05, 1.6), bi, bj, t, dirSign: rng() < 0.5 ? 1 : -1, offset,
        tx: 0, tz: 0, crossTo: [0, 0, 0], crossAxis: 0, crossNode: [0, 0], timer: 0,
        phase: rng() * 10, tilt: 0, fallYaw: 0, spin: 0, look: randomLook(rng), downTime: 0, officer: null,
      }
      this.list.push(p)
      return p
    }
    return null
  }

  /** パトカーのドアから警官を降ろす */
  addOfficer(x: number, z: number, car: number): Ped {
    const p: Ped = {
      id: this.nextId++, x, z, y: 0, yaw: 0, vx: 0, vy: 0, vz: 0, mode: 'officer', walkSpeed: 1.4,
      bi: 0, bj: 0, t: 0, dirSign: 1, offset: 0, tx: x, tz: z, crossTo: [0, 0, 0], crossAxis: 0, crossNode: [0, 0],
      timer: 0, phase: 0, tilt: 0, fallYaw: 0, spin: 0,
      look: { ...UNIFORM, height: range(this.rng, 0.97, 1.05), skin: pick(this.rng, [0xe0ac80, 0xf1c9a5, 0xc68c5a]) },
      downTime: 0, officer: { car, phase: 'out', run: false, face: 0 },
    }
    this.list.push(p)
    return p
  }

  /** 逃げ出す。(x, z) は逃げる相手の位置 */
  scare(p: Ped, x: number, z: number, strength = 1): void {
    if (isDown(p) || p.mode === 'stagger' || p.mode === 'officer') return
    let ax = p.x - x, az = p.z - z
    const d = Math.hypot(ax, az) || 1
    ax /= d; az /= d
    // 少し横へずらして、みんなが同じ向きに逃げないように
    const a = Math.atan2(ax, az) + (this.rng() - 0.5) * 1.2
    p.mode = 'flee'
    p.yaw = a
    p.timer = range(this.rng, 4, 7) * strength
  }

  /** 車にはねられた。v は車の速度 */
  knock(p: Ped, vx: number, vz: number, speed: number): void {
    const rng = this.rng
    if (speed < 3) {
      // ゆっくり押されただけ: よろけて転び、起き上がって逃げる
      p.mode = 'stagger'
      p.vx = vx * 0.8; p.vz = vz * 0.8; p.vy = 0
      p.fallYaw = Math.atan2(vx, vz)
      p.timer = 2.4
      return
    }
    p.mode = 'fly'
    const side = (rng() - 0.5) * speed * 0.35
    const n = Math.hypot(vx, vz) || 1
    p.vx = vx * 1.05 + (-vz / n) * side
    p.vz = vz * 1.05 + (vx / n) * side
    p.vy = 2 + speed * 0.32
    p.fallYaw = Math.atan2(vx, vz)
    p.spin = 5 + speed * 0.5
    p.downTime = 0
  }

  /** 爆風 */
  blast(p: Ped, x: number, z: number, power: number): void {
    let ax = p.x - x, az = p.z - z
    const d = Math.hypot(ax, az) || 1
    ax /= d; az /= d
    const k = power / Math.max(d, 1.5)
    p.mode = 'fly'
    p.vx = ax * k; p.vz = az * k; p.vy = 3 + k * 0.4
    p.fallYaw = Math.atan2(ax, az)
    p.spin = 6
  }

  private pushOutOfBuildings(p: Ped): void {
    if (!this.map.insideBuilding(p.x, p.z, 0.3)) return
    // 少しずつ戻す方向を探す
    for (const r of [0.4, 0.8, 1.5, 3]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r
        if (!this.map.insideBuilding(x, z, 0.3)) { p.x = x; p.z = z; return }
      }
    }
  }

  update(dt: number, time: number): void {
    for (const p of this.list) this.step(p, dt, time)
  }

  private step(p: Ped, dt: number, time: number): void {
    const rng = this.rng
    switch (p.mode) {
      case 'walk': {
        const S = this.ringHalf(p)
        const L = 8 * S
        const before = p.t
        p.t += p.dirSign * p.walkSpeed * dt
        // 角（t = 2S の倍数）を通り過ぎたか。通り過ぎたのは「辺 k の終わり」の角
        const segBefore = Math.floor(before / (2 * S))
        const segAfter = Math.floor(p.t / (2 * S))
        if (segBefore !== segAfter && rng() < 0.35) this.tryCross(p, S, (p.dirSign > 0 ? segAfter : segBefore) - 1)
        p.t = ((p.t % L) + L) % L
        if (p.mode === 'walk') {
          const [x, z, yaw] = ringPoint(blockCenter(p.bi), blockCenter(p.bj), S, p.t)
          p.x = x; p.z = z
          p.yaw = yaw + (p.dirSign < 0 ? Math.PI : 0)
        }
        p.phase += p.walkSpeed * dt * 3.4
        break
      }
      case 'wait': {
        const light = CityMap.light(p.crossNode[0], p.crossNode[1], p.crossAxis, time)
        // 渡る道を走る車が赤のときだけ渡る
        if (light === 'red' && CityMap.light(p.crossNode[0], p.crossNode[1], p.crossAxis === 0 ? 1 : 0, time) !== 'red') {
          p.mode = 'cross'
        }
        p.timer -= dt
        if (p.timer < 0) { p.mode = 'walk'; p.dirSign = -p.dirSign }
        break
      }
      case 'cross': {
        const dx = p.tx - p.x, dz = p.tz - p.z
        const d = Math.hypot(dx, dz)
        const v = p.walkSpeed * 1.15
        if (d < v * dt + 0.05) {
          p.bi = p.crossTo[0]; p.bj = p.crossTo[1]; p.t = p.crossTo[2]
          p.mode = 'walk'
          p.dirSign = rng() < 0.5 ? 1 : -1
        } else {
          p.x += (dx / d) * v * dt; p.z += (dz / d) * v * dt
          p.yaw = Math.atan2(dx, dz)
        }
        p.phase += v * dt * 3.4
        break
      }
      case 'flee': {
        const v = 5.2
        let nx = p.x + Math.sin(p.yaw) * v * dt
        let nz = p.z + Math.cos(p.yaw) * v * dt
        if (this.map.insideBuilding(nx, nz, 0.3)) {
          // 壁に当たったら向きを変える
          p.yaw += (rng() < 0.5 ? 1 : -1) * Math.PI / 2
          nx = p.x; nz = p.z
        }
        p.x = nx; p.z = nz
        p.phase += v * dt * 2.6
        p.timer -= dt
        if (p.timer < 0) this.startReturn(p)
        break
      }
      case 'return': {
        const dx = p.tx - p.x, dz = p.tz - p.z
        const d = Math.hypot(dx, dz)
        const v = 1.8
        if (d < 0.3) { p.mode = 'walk'; break }
        const nx = p.x + (dx / d) * Math.min(v * dt, d)
        const nz = p.z + (dz / d) * Math.min(v * dt, d)
        if (this.map.insideBuilding(nx, nz, 0.3)) { this.startReturn(p, true); break }
        p.x = nx; p.z = nz
        p.yaw = Math.atan2(dx, dz)
        p.phase += v * dt * 3.2
        break
      }
      case 'stagger': {
        p.x += p.vx * dt; p.z += p.vz * dt
        p.vx *= Math.exp(-4 * dt); p.vz *= Math.exp(-4 * dt)
        p.timer -= dt
        // 倒れて、また起き上がる
        const target = p.timer > 0.7 ? Math.PI / 2 : 0
        p.tilt += (target - p.tilt) * Math.min(1, dt * 9)
        this.pushOutOfBuildings(p)
        if (p.timer < 0) { p.tilt = 0; this.scare(p, p.x - p.vx, p.z - p.vz) }
        break
      }
      case 'fly': {
        p.vy -= 9.81 * dt
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
        p.tilt += p.spin * dt
        if (p.y <= 0) {
          p.y = 0
          if (Math.abs(p.vy) > 3) {
            // 地面で弾む
            p.vy = -p.vy * 0.3
            p.vx *= 0.6; p.vz *= 0.6
            p.spin *= 0.5
          } else {
            p.vy = 0
            p.vx *= Math.exp(-5 * dt); p.vz *= Math.exp(-5 * dt)
            p.spin *= Math.exp(-6 * dt)
            if (Math.hypot(p.vx, p.vz) < 0.4) {
              p.mode = 'down'
              p.downTime = 0
            }
          }
        }
        this.pushOutOfBuildings(p)
        break
      }
      case 'officer': {
        // 目的の場所へ歩く（走る）。着いたら決められた向きを向いて立つ
        const o = p.officer!
        const dx = p.tx - p.x, dz = p.tz - p.z
        const d = Math.hypot(dx, dz)
        const v = o.run ? 4.6 : 1.5
        if (d > 0.25) {
          const step = Math.min(v * dt, d)
          const nx = p.x + (dx / d) * step, nz = p.z + (dz / d) * step
          if (!this.map.insideBuilding(nx, nz, 0.3)) { p.x = nx; p.z = nz }
          p.yaw = Math.atan2(dx, dz)
          p.phase += v * dt * (o.run ? 2.6 : 3.4)
          p.mode = 'officer'
        } else {
          p.yaw += Math.atan2(Math.sin(o.face - p.yaw), Math.cos(o.face - p.yaw)) * Math.min(1, dt * 6)
        }
        break
      }
      case 'down': {
        // 寝た姿勢へ寄せる（何回転していても、最後は仰向け・うつ伏せのどちらかに落ち着く）
        const k = Math.round((p.tilt - Math.PI / 2) / Math.PI)
        const target = Math.PI / 2 + k * Math.PI
        p.tilt += (target - p.tilt) * Math.min(1, dt * 10)
        p.downTime += dt
        break
      }
    }
  }

  /** 角に来たとき、そこの横断歩道を渡るか決める */
  private tryCross(p: Ped, S: number, seg: number): void {
    const k = ((seg % 4) + 4) % 4
    // 角の向き: 辺 k の終わり（辺 0 の終わりは (+x, −z) の角）
    const sx = k === 0 || k === 1 ? 1 : -1
    const sz = k === 1 || k === 2 ? 1 : -1
    const alongX = this.rng() < 0.5
    const nbi = p.bi + (alongX ? sx : 0)
    const nbj = p.bj + (alongX ? 0 : sz)
    if (nbi < 0 || nbj < 0 || nbi >= BLOCKS || nbj >= BLOCKS) return
    const cx = blockCenter(p.bi), cz = blockCenter(p.bj)
    // 渡った先の角
    const ncx = blockCenter(nbi), ncz = blockCenter(nbj)
    const tsx = alongX ? -sx : sx
    const tsz = alongX ? sz : -sz
    p.x = cx + sx * S; p.z = cz + sz * S
    p.tx = ncx + tsx * S; p.tz = ncz + tsz * S
    p.crossTo = [nbi, nbj, cornerT(S, tsx, tsz)]
    // x 方向に渡る = z 方向に走る道（axis 1）を横切る
    p.crossAxis = alongX ? 1 : 0
    p.crossNode = [p.bi + (sx > 0 ? 1 : 0), p.bj + (sz > 0 ? 1 : 0)]
    p.mode = 'wait'
    p.timer = 30
    p.yaw = Math.atan2(p.tx - p.x, p.tz - p.z)
  }

  /** 逃げ終わったら、近くの歩道へ戻る */
  private startReturn(p: Ped, farther = false): void {
    const bi = Math.min(Math.max(Math.floor((p.x + PITCH * BLOCKS / 2) / PITCH), 0), BLOCKS - 1)
    const bj = Math.min(Math.max(Math.floor((p.z + PITCH * BLOCKS / 2) / PITCH), 0), BLOCKS - 1)
    p.bi = bi; p.bj = bj
    const S = this.ringHalf(p)
    let t = nearestT(blockCenter(bi), blockCenter(bj), S, p.x, p.z)
    if (farther) t += (this.rng() - 0.5) * 20
    p.t = t
    const [x, z] = ringPoint(blockCenter(bi), blockCenter(bj), S, t)
    if (farther && Math.hypot(x - p.x, z - p.z) < 1) {
      // どうしても戻れないときは歩道へ移す（画面の外で起きることがほとんど）
      p.x = x; p.z = z; p.mode = 'walk'; return
    }
    p.tx = x; p.tz = z
    p.mode = 'return'
  }

  remove(pred: (p: Ped) => boolean): Ped[] {
    const removed: Ped[] = []
    for (let k = this.list.length - 1; k >= 0; k--) {
      if (pred(this.list[k])) removed.push(...this.list.splice(k, 1))
    }
    return removed
  }
}
