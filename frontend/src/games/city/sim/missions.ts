// ミッション。街のあちこちにある光る輪（マーカー）に車で入ると始まる。
//
//   delivery     目的地まで時間内に走る
//   reach        目的地へ行く（時間制限なし。物語の移動用）
//   rampage      制限時間内に決まった人数をはねる（騒ぎを起こす）
//   escape       いきなり手配度が上がる。警察をまいたら成功
//   checkpoints  順番に輪をくぐる
//   takedown     逃げる標的の車を壊す
//
// 物語のミッション（sim/story.ts）も、寄り道のミッションも、同じ MissionDef で表す。

import { DIRS, LANE_OFFSETS, NODES, PITCH, ROAD_HALF, leftOf, nodeX } from './cityMap'
import { makeRng, type Rng } from './rng'
import type { VehicleType } from './vehicle'

export type MissionKind = 'delivery' | 'reach' | 'rampage' | 'escape' | 'checkpoints' | 'takedown'

export interface MissionDef {
  kind: MissionKind
  title: string
  /** 制限時間（秒）。省略すると種類ごとの既定 */
  time?: number
  /** rampage の人数・checkpoints の数 */
  count?: number
  /** escape で上がる手配度 */
  stars?: number
  /** delivery / reach の目的地までの距離（m） */
  distance?: [number, number]
  /** takedown の標的の車種 */
  target?: VehicleType
  reward: number
}

export interface Marker {
  x: number
  z: number
  def: MissionDef
  /** 物語のマーカーか（色が違う） */
  story: boolean
}

/** 道路の上の地点: 交差点 (i, j) から dir の向きに frac だけ進んだ、外側の車線 */
export function roadSpot(i: number, j: number, dir: number, frac = 0.5): [number, number, number] {
  const [dx, dz] = DIRS[dir]
  const [lx, lz] = leftOf(dx, dz)
  const s = ROAD_HALF + (PITCH - 2 * ROAD_HALF) * frac
  return [nodeX(i) + dx * s + lx * LANE_OFFSETS[1], nodeX(j) + dz * s + lz * LANE_OFFSETS[1], Math.atan2(dx, dz)]
}

/** 乱数で道路上の地点を選ぶ（街の外へはみ出さないもの） */
export function randomRoadSpot(rng: Rng, x: number, z: number, min: number, max: number): [number, number] {
  let best: [number, number] = [x, z]
  for (let k = 0; k < 120; k++) {
    const i = Math.floor(rng() * NODES), j = Math.floor(rng() * NODES)
    const dir = Math.floor(rng() * 4)
    const [dx, dz] = DIRS[dir]
    if (i + dx < 0 || j + dz < 0 || i + dx >= NODES || j + dz >= NODES) continue
    const [px, pz] = roadSpot(i, j, dir, 0.3 + rng() * 0.4)
    const d = Math.hypot(px - x, pz - z)
    best = [px, pz]
    if (d >= min && d <= max) return best
  }
  return best
}

const SIDE_DEFS: MissionDef[] = [
  { kind: 'delivery', title: '配達', reward: 800 },
  { kind: 'rampage', title: '暴走', count: 12, time: 60, reward: 1500 },
  { kind: 'escape', title: '逃走', stars: 3, reward: 2000 },
  { kind: 'checkpoints', title: 'チェックポイント', count: 6, time: 75, reward: 1200 },
  { kind: 'takedown', title: '標的を壊せ', target: 'sedan', time: 120, reward: 1800 },
]

/** 寄り道のミッションの輪を、街の大きさに合わせて散らす */
export function sideMarkers(seed: number): Marker[] {
  const rng = makeRng(seed ^ 0xabcdef)
  const n = Math.max(6, Math.round(NODES * 0.7))
  const out: Marker[] = []
  for (let k = 0; k < n; k++) {
    const i = 1 + Math.floor(rng() * (NODES - 2)), j = 1 + Math.floor(rng() * (NODES - 2))
    const [x, z] = roadSpot(i, j, Math.floor(rng() * 4), 0.5)
    if (out.some((m) => Math.hypot(m.x - x, m.z - z) < 150)) continue
    out.push({ x, z, def: SIDE_DEFS[k % SIDE_DEFS.length], story: false })
  }
  return out
}

export const MARKER_RADIUS = 5

export interface MissionStatus {
  def: MissionDef
  story: boolean
  /** HUD に出す 1 行 */
  text: string
  timeLeft: number | null
  /** 今向かう場所（無ければ null） */
  target: [number, number] | null
}

export type MissionResult = { ok: boolean; reward: number; text: string; story: boolean }

/** ミッションが game.ts に頼むこと */
export interface MissionHooks {
  setStars(n: number): void
  /** 逃げる標的の車を出し、その番号を返す */
  spawnTarget(type: VehicleType, x: number, z: number): number
  /** 標的の今の位置と、壊れたか（消えたら null） */
  targetState(id: number): { x: number; z: number; wrecked: boolean } | null
}

export class Missions {
  active: MissionStatus | null = null
  private count = 0
  private points: [number, number][] = []
  private pedsAtStart = 0
  private targetId = -1
  /** 一度終わった輪は、少し離れるまで反応しない（終わった直後にまた始まらないように） */
  private cooldown: Marker | null = null
  private rng: Rng

  constructor(rng: Rng) { this.rng = rng }

  /** 輪に入ったか調べる。入った輪を返す（始めるかどうかは game.ts が決める） */
  touched(markers: Marker[], x: number, z: number): Marker | null {
    if (this.active) return null
    for (const m of markers) {
      const d = Math.hypot(m.x - x, m.z - z)
      if (this.cooldown === m) { if (d > MARKER_RADIUS * 4) this.cooldown = null; continue }
      if (d < MARKER_RADIUS) { this.cooldown = m; return m }
    }
    return null
  }

  start(def: MissionDef, story: boolean, x: number, z: number, pedsHit: number, hooks: MissionHooks): MissionStatus {
    const base = { def, story }
    switch (def.kind) {
      case 'delivery':
      case 'reach': {
        const [lo, hi] = def.distance ?? [380, 700]
        const t = randomRoadSpot(this.rng, x, z, lo, hi)
        const d = Math.abs(t[0] - x) + Math.abs(t[1] - z)
        const time = def.kind === 'reach' ? null : def.time ?? Math.round(d / 13 + 15)
        this.active = { ...base, text: def.kind === 'reach' ? '目的地へ向かえ' : '荷物を目的地へ届けろ', timeLeft: time, target: t }
        break
      }
      case 'rampage':
        this.pedsAtStart = pedsHit
        this.active = { ...base, text: `${def.time ?? 60} 秒で ${def.count ?? 12} 人はねろ`, timeLeft: def.time ?? 60, target: null }
        break
      case 'escape':
        hooks.setStars(def.stars ?? 3)
        this.active = { ...base, text: '警察をまけ', timeLeft: def.time ?? null, target: null }
        break
      case 'checkpoints': {
        this.points = []
        let [px, pz] = [x, z]
        for (let k = 0; k < (def.count ?? 6); k++) {
          const p = randomRoadSpot(this.rng, px, pz, 150, 280)
          this.points.push(p)
          ;[px, pz] = p
        }
        this.count = 0
        this.active = { ...base, text: `輪をくぐれ 0 / ${this.points.length}`, timeLeft: def.time ?? 75, target: this.points[0] }
        break
      }
      case 'takedown': {
        const [tx, tz] = randomRoadSpot(this.rng, x, z, 160, 260)
        this.targetId = hooks.spawnTarget(def.target ?? 'sedan', tx, tz)
        this.active = { ...base, text: '標的の車を壊せ', timeLeft: def.time ?? 150, target: [tx, tz] }
        break
      }
    }
    return this.active!
  }

  /** 毎フレーム。終わったら結果を返す */
  update(dt: number, x: number, z: number, pedsHit: number, stars: number, hooks: MissionHooks): MissionResult | null {
    const a = this.active
    if (!a) return null
    const def = a.def
    if (a.timeLeft !== null) {
      a.timeLeft -= dt
      if (a.timeLeft <= 0) return this.finish(false, 0, '時間切れ')
    }
    const bonus = Math.round((a.timeLeft ?? 0) * 25)
    switch (def.kind) {
      case 'delivery':
      case 'reach':
        if (a.target && Math.hypot(a.target[0] - x, a.target[1] - z) < MARKER_RADIUS + 1) {
          return this.finish(true, def.reward + bonus, def.kind === 'reach' ? '到着' : '配達完了')
        }
        break
      case 'rampage': {
        const n = pedsHit - this.pedsAtStart
        const goal = def.count ?? 12
        a.text = `はねた人数 ${n} / ${goal}`
        if (n >= goal) return this.finish(true, def.reward + bonus, '騒ぎは十分だ')
        break
      }
      case 'escape':
        if (stars === 0) return this.finish(true, def.reward, '逃げ切った')
        break
      case 'checkpoints':
        if (a.target && Math.hypot(a.target[0] - x, a.target[1] - z) < MARKER_RADIUS + 1.5) {
          this.count++
          a.timeLeft = (a.timeLeft ?? 0) + 6
          if (this.count >= this.points.length) return this.finish(true, def.reward + bonus, '全チェックポイント通過')
          a.target = this.points[this.count]
          a.text = `輪をくぐれ ${this.count} / ${this.points.length}`
        }
        break
      case 'takedown': {
        const t = hooks.targetState(this.targetId)
        if (!t) return this.finish(false, 0, '標的を見失った')
        a.target = [t.x, t.z]
        const d = Math.hypot(t.x - x, t.z - z)
        a.text = `標的の車を壊せ（${Math.round(d)}m）`
        if (t.wrecked) return this.finish(true, def.reward + bonus, '標的を仕留めた')
        break
      }
    }
    return null
  }

  get targetVehicle(): number { return this.active?.def.kind === 'takedown' ? this.targetId : -1 }

  private finish(ok: boolean, reward: number, text: string): MissionResult {
    const story = this.active?.story ?? false
    this.active = null
    this.targetId = -1
    return { ok, reward, text, story }
  }

  /** 捕まった・やられたときは失敗にする */
  fail(): MissionResult | null {
    if (!this.active) return null
    return this.finish(false, 0, 'ミッション失敗')
  }
}
