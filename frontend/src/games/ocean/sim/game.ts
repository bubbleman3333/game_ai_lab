// 海を泳ぐゲームの進行（ルール）。React にも three.js にも依存しない。
//
// 世界の座標: x = 右左（**右がマイナス**。レースと同じ決まり）、y = 上（0 が海面、潜るとマイナス）、
// z = 前。泳ぐ向きは常に +z で、泳いだ距離 = z。
//
// 毎フレーム update(dt, input) を呼ぶと、その時間ぶん進めて「起きたこと」（Event の配列）を返す。
// 画面（scene/）と音（sounds.ts）はこの出来事を見て演出する。
//
// 登場するもの:
//   クラゲ  漂っている。触れると刺されて体力が減り、少しのあいだ動きが鈍る
//   サメ    たまに現れ、しばらく周りをうろついてから突っ込んでくる。横に避けるか、
//           目の前まで来た瞬間に蹴る（kick）と追い払える。噛まれると大きく体力が減る
//   真珠    拾うと得点
//
// 潜ると（dive）クラゲの上や下を抜けられるが、息（air）が減る。息が切れると体力が減っていく。

import { Rng } from './rng'
import { zoneAt, type Zone } from './zones'

export interface Input {
  /** -1〜1。正で右（画面で見た右。ワールドでは -x） */
  steer: number
  /** 潜っているか（押しているあいだ） */
  dive: boolean
  /** 速く泳ぐか（押しているあいだ。スタミナを使う） */
  dash: boolean
  /** このフレームに蹴ったか（押した瞬間だけ true） */
  kick: boolean
}

export const NO_INPUT: Input = { steer: 0, dive: false, dash: false, kick: false }

// --- 泳ぐ人 -------------------------------------------------------------------
export const MAX_HP = 6
export const MAX_AIR = 100
export const MAX_STAMINA = 100
export const LANE = 24 // 左右に行ける範囲（m）。外は沖に流されないよう押し戻す
export const MAX_DEPTH = -30 // 潜れる深さ（浅瀬では海底の少し上で止まる）
export const DEEP_PEARL_DEPTH = -9 // これより深い真珠は「深海の真珠」（点が高い）
export const SWIM_SPEED = 3.4 // 普通に泳ぐ速さ（m/s）
export const DASH_SPEED = 5.6
const STRAFE_SPEED = 4.2 // 横に動く速さ
const DIVE_SPEED = 3.4 // 潜る速さ
const FLOAT_SPEED = 2.6 // 浮き上がる速さ
const AIR_DRAIN = 3.2 // 潜っているときに息が減る速さ（毎秒。100 で約 30 秒）
const AIR_DRAIN_DEEP = 1.0 // 深く潜るほど余分に減る（一番深いところでこの分が足される）
const AIR_REGEN = 45
const STAMINA_DRAIN = 26
const STAMINA_REGEN = 14
const DROWN_INTERVAL = 1.4 // 息が切れたあと、体力が 1 減る間隔（秒）
const STING_STUN = 1.0 // 刺されたあと動きが鈍る時間
const STING_INVULN = 1.6 // 刺されたあと無敵の時間
const BITE_INVULN = 2.2
const PLAYER_RADIUS = 0.55

// --- クラゲ -------------------------------------------------------------------
const JELLY_RADIUS = 1.0

// --- サメ ---------------------------------------------------------------------
const SHARK_STALK_RADIUS = 20 // うろつくときの距離
const SHARK_STALK_TIME: [number, number] = [4.5, 7.5]
const SHARK_RESTALK_TIME: [number, number] = [2.0, 3.5] // 2 回目以降のうろつき（短い）
const SHARK_CHARGE_SPEED = 12
// 突っ込み中に向きを直せる速さ（rad/s）。サメは突っ込み始めに「今の泳ぎ方を続けたらいる場所」を狙い、
// あとはほぼまっすぐ来る（本物の待ち伏せと同じで、一度決めたら曲がれない）。
// だから、そのまま泳いでいると当たり、突っ込みが始まってから横へ動けば（ダッシュや潜りでも）外れる。
// 大きくすると避けられなくなり、蹴るしかなくなる。0.06 は「ほとんど直進」
const SHARK_TURN_RATE = 0.06
const SHARK_LEAD_MAX = 1.6 // 先読みする秒数の上限
const SHARK_BITE_RANGE = 1.9
const SHARK_KICK_RANGE = 3.6 // この距離まで来てから蹴ると追い払える
const SHARK_DODGE_RANGE = 5 // 噛まれずにこの距離を通り過ぎたら「かわした」
const SHARK_RETREAT_TIME = 1.8
const SHARK_LEAVE_DIST = 55
export const SHARK_DEPTH = -1.3 // うろつくときの深さ（背びれが海面に出る）

// --- 真珠 ---------------------------------------------------------------------
const PEARL_RADIUS = 1.1 // 拾える距離（少し広め）
export const PEARL_SCORE = 10
export const DEEP_PEARL_SCORE = 40
export const DODGE_SCORE = 20
export const PUNCH_SCORE = 50

// 先読みしてものを置く距離と、後ろに流れたものを消す距離
const SPAWN_AHEAD = 150
const DESPAWN_BEHIND = 30

export type Cause = 'shark' | 'jelly' | 'drown'

export type EventKind =
  | 'sting'        // クラゲに刺された
  | 'bite'         // サメに噛まれた
  | 'dodge'        // サメをかわした
  | 'punch'        // サメを蹴って追い払った
  | 'kick'         // 空振りの蹴り（演出用）
  | 'pearl'        // 真珠を拾った
  | 'shark-warn'   // サメが現れた
  | 'shark-charge' // サメが突っ込み始めた
  | 'shark-leave'  // サメが去った
  | 'zone'         // 区間が変わった
  | 'surface'      // 海面に上がった（息継ぎ）
  | 'submerge'     // 潜った
  | 'drowning'     // 息が切れて体力が減った
  | 'dead'

export interface GameEvent {
  kind: EventKind
  value?: number
  /** 出来事の場所（演出用） */
  x?: number
  y?: number
  z?: number
}

export interface Player {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  /** 前に進む速さ（m/s） */
  speed: number
  hp: number
  air: number
  stamina: number
  /** 刺されて動きが鈍っている残り時間 */
  stun: number
  /** 無敵の残り時間 */
  invuln: number
  /** 蹴りの動きの残り時間（演出用） */
  kickAnim: number
  dashing: boolean
}

export interface Jelly {
  id: number
  x: number
  y: number
  z: number
  /** 大きさ（1 が標準）。当たり判定にも掛かる */
  size: number
  /** 漂う動きの位相 */
  phase: number
  /** 色の種類（0〜2。見た目だけ） */
  kind: number
}

export type SharkState = 'stalk' | 'charge' | 'retreat' | 'leave'

export interface Shark {
  id: number
  x: number
  y: number
  z: number
  /** 向き（yaw。前 = +z が 0、右手系なので右を向くと減る） */
  yaw: number
  speed: number
  state: SharkState
  /** 今の状態の残り時間（stalk / retreat） */
  timer: number
  /** うろつくときに周る向き（1 か -1） */
  orbit: number
  /** 周る角度 */
  orbitAngle: number
  /** あと何回突っ込んでくるか */
  passes: number
  /** 今の突っ込みでもう噛んだ・かわされた（二重に判定しないため） */
  resolved: boolean
  /** 突っ込みで一番近づいた距離（かわした判定に使う） */
  closest: number
}

export interface Pearl {
  id: number
  x: number
  y: number
  z: number
  phase: number
  /** 拾ったときの点（深い真珠は高い） */
  value: number
}

export class OceanGame {
  readonly player: Player = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, speed: 0,
    hp: MAX_HP, air: MAX_AIR, stamina: MAX_STAMINA,
    stun: 0, invuln: 0, kickAnim: 0, dashing: false,
  }
  readonly jellies: Jelly[] = []
  readonly sharks: Shark[] = []
  readonly pearls: Pearl[] = []
  /** 経過時間（秒） */
  time = 0
  score = 0
  pearlsTaken = 0
  /** 真珠でとった点の合計 */
  pearlScore = 0
  dodges = 0
  punches = 0
  stings = 0
  bites = 0
  dead = false
  cause: Cause | null = null
  zone: Zone = zoneAt(0)

  private rng: Rng
  private nextId = 1
  private jellyCursor = 40 // 次にクラゲの群れを置く z
  private pearlCursor = 25
  private sharkTimer: number
  private drownTimer = 0
  private wasUnder = false

  constructor(seed = Date.now() & 0xffffffff) {
    this.rng = new Rng(seed)
    this.sharkTimer = this.rng.range(14, 22) // 最初のサメは少し待ってから
    this.fill()
  }

  /** 泳いだ距離（m） */
  get distance(): number {
    return this.player.z
  }

  /** 潜っているか（頭が水の中） */
  get underwater(): boolean {
    return this.player.y < -0.45
  }

  /** 一番近くにいる（突っ込み待ちか突っ込み中の）サメ。HUD の警告に使う */
  get threat(): Shark | null {
    let best: Shark | null = null
    let bestD = Infinity
    for (const s of this.sharks) {
      if (s.state === 'leave') continue
      const d = Math.hypot(s.x - this.player.x, s.z - this.player.z)
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  }

  update(dt: number, input: Input): GameEvent[] {
    const events: GameEvent[] = []
    if (this.dead) return events
    dt = Math.min(dt, 0.1)
    this.time += dt
    const p = this.player

    // --- 泳ぐ人 ---------------------------------------------------------
    p.stun = Math.max(0, p.stun - dt)
    p.invuln = Math.max(0, p.invuln - dt)
    p.kickAnim = Math.max(0, p.kickAnim - dt)

    const stunK = p.stun > 0 ? 0.35 : 1
    p.dashing = input.dash && p.stamina > 0 && p.stun <= 0
    const wantSpeed = (p.dashing ? DASH_SPEED : SWIM_SPEED) * stunK
    p.speed += (wantSpeed - p.speed) * Math.min(1, dt * 4)
    p.z += p.speed * dt

    // 横: 右は -x
    const wantVx = -Math.max(-1, Math.min(1, input.steer)) * STRAFE_SPEED * stunK
    p.vx += (wantVx - p.vx) * Math.min(1, dt * 8)
    p.x += p.vx * dt
    if (p.x > LANE) { p.x = LANE; p.vx = Math.min(p.vx, 0) }
    if (p.x < -LANE) { p.x = -LANE; p.vx = Math.max(p.vx, 0) }

    // 区間（潜れる深さは区間の海底で決まるので、上下の前に更新する）
    const zone = zoneAt(p.z)
    if (zone !== this.zone) {
      this.zone = zone
      events.push({ kind: 'zone', value: zone.from })
    }

    // 上下: 押しているあいだ潜り、離すと浮く
    const wantVy = input.dive && p.stun <= 0 ? -DIVE_SPEED : FLOAT_SPEED
    p.vy += (wantVy - p.vy) * Math.min(1, dt * 5)
    p.y += p.vy * dt
    if (p.y > 0) { p.y = 0; p.vy = 0 }
    const floorLimit = Math.max(MAX_DEPTH, this.zone.floorY + 3.5) // 海底（起伏ぶん余裕をとる）の上で止まる
    if (p.y < floorLimit) { p.y = floorLimit; p.vy = Math.max(p.vy, 0) }

    // 息とスタミナ
    const under = this.underwater
    if (under) {
      const depthK = Math.min(1, p.y / MAX_DEPTH)
      p.air = Math.max(0, p.air - (AIR_DRAIN + AIR_DRAIN_DEEP * depthK) * dt)
      if (p.air <= 0) {
        this.drownTimer += dt
        if (this.drownTimer >= DROWN_INTERVAL) {
          this.drownTimer = 0
          this.damage(1, 'drown')
          events.push({ kind: 'drowning', x: p.x, y: p.y, z: p.z })
        }
      }
    } else {
      p.air = Math.min(MAX_AIR, p.air + AIR_REGEN * dt)
      this.drownTimer = 0
    }
    if (under !== this.wasUnder) {
      events.push({ kind: under ? 'submerge' : 'surface', x: p.x, y: p.y, z: p.z })
      this.wasUnder = under
    }
    if (p.dashing) p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * dt)
    else p.stamina = Math.min(MAX_STAMINA, p.stamina + STAMINA_REGEN * dt)

    // 距離そのものも得点（1m = 1 点）
    this.score = Math.floor(p.z) + this.pearlScore + this.dodges * DODGE_SCORE + this.punches * PUNCH_SCORE

    // --- 蹴り ---------------------------------------------------------------
    let kicked = false
    if (input.kick && p.stun <= 0) {
      p.kickAnim = 0.45
      kicked = true
    }

    // --- クラゲ -------------------------------------------------------------
    for (const j of this.jellies) {
      // ゆっくり漂う（左右に揺れ、上下にふわふわ）
      j.x += Math.sin(this.time * 0.5 + j.phase) * 0.35 * dt
      j.y += Math.cos(this.time * 0.7 + j.phase) * 0.25 * dt
      if (j.y > -0.3) j.y = -0.3
      if (p.invuln <= 0 && this.hit(j.x, j.y, j.z, JELLY_RADIUS * j.size + PLAYER_RADIUS)) {
        this.stings++
        this.damage(1, 'jelly')
        p.stun = STING_STUN
        p.invuln = STING_INVULN
        p.speed *= 0.4
        events.push({ kind: 'sting', x: j.x, y: j.y, z: j.z })
      }
    }

    // --- 真珠 ---------------------------------------------------------------
    for (let i = this.pearls.length - 1; i >= 0; i--) {
      const q = this.pearls[i]
      if (this.hit(q.x, q.y, q.z, PEARL_RADIUS)) {
        this.pearls.splice(i, 1)
        this.pearlsTaken++
        this.pearlScore += q.value
        events.push({ kind: 'pearl', value: q.value, x: q.x, y: q.y, z: q.z })
      }
    }

    // --- サメ ---------------------------------------------------------------
    this.sharkTimer -= dt
    if (this.sharkTimer <= 0 && this.sharks.length === 0) {
      this.spawnShark(events)
      const [lo, hi] = this.zone.sharkInterval
      this.sharkTimer = this.rng.range(lo, hi)
    }
    for (let i = this.sharks.length - 1; i >= 0; i--) {
      const s = this.sharks[i]
      this.updateShark(s, dt, kicked, events)
      if (s.state === 'leave' && Math.hypot(s.x - p.x, s.z - p.z) > SHARK_LEAVE_DIST) {
        this.sharks.splice(i, 1)
        events.push({ kind: 'shark-leave' })
      }
    }
    if (kicked && !events.some((e) => e.kind === 'punch')) {
      events.push({ kind: 'kick', x: p.x, y: p.y, z: p.z })
    }

    // --- 置く・片づける -----------------------------------------------------
    this.fill()
    this.cull()

    if (p.hp <= 0 && !this.dead) {
      this.dead = true
      events.push({ kind: 'dead', x: p.x, y: p.y, z: p.z })
    }
    return events
  }

  private hit(x: number, y: number, z: number, r: number): boolean {
    const p = this.player
    const dx = x - p.x, dy = y - p.y, dz = z - p.z
    return dx * dx + dy * dy + dz * dz < r * r
  }

  private damage(n: number, cause: Cause): void {
    const p = this.player
    if (p.hp <= 0) return
    p.hp = Math.max(0, p.hp - n)
    if (p.hp <= 0) this.cause = cause
  }

  // --- サメの動き -----------------------------------------------------------
  private spawnShark(events: GameEvent[]): void {
    const p = this.player
    // 横か後ろから現れる（正面から来ると心構えができてしまう）
    const side = this.rng.next() < 0.5 ? 1 : -1
    const angle = side * this.rng.range(Math.PI * 0.35, Math.PI * 0.8) // 前 = 0 から測った角度
    const [plo, phi] = this.zone.sharkPasses
    const [tlo, thi] = SHARK_STALK_TIME
    const s: Shark = {
      id: this.nextId++,
      x: p.x + Math.sin(angle) * SHARK_STALK_RADIUS,
      y: SHARK_DEPTH,
      z: p.z + Math.cos(angle) * SHARK_STALK_RADIUS,
      yaw: 0, speed: 0,
      state: 'stalk', timer: this.rng.range(tlo, thi),
      orbit: side, orbitAngle: angle,
      passes: this.rng.int(plo, phi),
      resolved: false, closest: Infinity,
    }
    this.sharks.push(s)
    events.push({ kind: 'shark-warn', x: s.x, y: s.y, z: s.z })
  }

  private updateShark(s: Shark, dt: number, kicked: boolean, events: GameEvent[]): void {
    const p = this.player
    const dx = p.x - s.x, dz = p.z - s.z
    const dist = Math.hypot(dx, dz)

    switch (s.state) {
      case 'stalk': {
        // 泳ぐ人の周りを、少し前寄りの位置へ向かって回る（背びれが見える距離）
        s.orbitAngle += s.orbit * 0.35 * dt
        const tx = p.x + Math.sin(s.orbitAngle) * SHARK_STALK_RADIUS
        const tz = p.z + Math.cos(s.orbitAngle) * SHARK_STALK_RADIUS
        this.steerTo(s, tx, tz, 6 + p.speed, 2.5, dt)
        s.y += (SHARK_DEPTH - s.y) * Math.min(1, dt * 2)
        s.timer -= dt
        if (s.timer <= 0) {
          // 突っ込みの始まりでは泳ぐ人のほうを向く（ここから先は向きをゆっくりしか直せない）
          s.state = 'charge'
          const lead = Math.min(dist / SHARK_CHARGE_SPEED, SHARK_LEAD_MAX)
          s.yaw = Math.atan2(dx + p.vx * lead, dz + p.speed * lead)
          s.resolved = false
          s.closest = Infinity
          events.push({ kind: 'shark-charge', x: s.x, y: s.y, z: s.z })
        }
        break
      }
      case 'charge': {
        // 「今の泳ぎ方を続けたらいる場所」へ向きを直しながら突っ込む
        // （直せる速さに上限があるので、突っ込みが始まってから横へ動けば避けられる）
        const lead = Math.min(dist / SHARK_CHARGE_SPEED, SHARK_LEAD_MAX)
        this.steerTo(s, p.x + p.vx * lead, p.z + p.speed * lead, SHARK_CHARGE_SPEED, SHARK_TURN_RATE, dt)
        // 深さも合わせる（潜っても追ってくるが、少し遅れる）
        s.y += (Math.min(p.y, -0.6) - s.y) * Math.min(1, dt * 1.5)
        s.closest = Math.min(s.closest, dist)

        const facing = Math.sin(s.yaw) * dx + Math.cos(s.yaw) * dz // 正なら泳ぐ人が前にいる
        // 蹴り: 目の前まで来ているサメを蹴ると追い払える
        if (kicked && !s.resolved && dist < SHARK_KICK_RANGE && facing > 0) {
          s.resolved = true
          s.passes = 0
          this.leave(s)
          this.punches++
          p.invuln = Math.max(p.invuln, 1.0)
          events.push({ kind: 'punch', value: PUNCH_SCORE, x: s.x, y: s.y, z: s.z })
          break
        }
        // 噛みつき
        const near3 = Math.hypot(dx, dz, p.y - s.y) < SHARK_BITE_RANGE
        if (!s.resolved && near3 && p.invuln <= 0) {
          s.resolved = true
          this.bites++
          this.damage(2, 'shark')
          p.invuln = BITE_INVULN
          p.stun = 0.6
          p.speed *= 0.3
          events.push({ kind: 'bite', x: s.x, y: s.y, z: s.z })
          this.afterPass(s)
          break
        }
        // 通り過ぎた（後ろに抜けた）
        if (facing < 0 && dist > 2.5) {
          if (!s.resolved && s.closest < SHARK_DODGE_RANGE) {
            this.dodges++
            events.push({ kind: 'dodge', value: DODGE_SCORE, x: s.x, y: s.y, z: s.z })
          }
          s.resolved = true
          this.afterPass(s)
        }
        break
      }
      case 'retreat': {
        // 少し離れてから、また回り込む
        const ax = s.x - p.x, az = s.z - p.z
        const len = Math.hypot(ax, az) || 1
        this.steerTo(s, p.x + (ax / len) * 30, p.z + (az / len) * 30 + 10, 8 + p.speed, 2.0, dt)
        s.timer -= dt
        if (s.timer <= 0) {
          const [lo, hi] = SHARK_RESTALK_TIME
          s.state = 'stalk'
          s.timer = this.rng.range(lo, hi)
          s.orbitAngle = Math.atan2(s.x - p.x, s.z - p.z)
          s.orbit = this.rng.next() < 0.5 ? 1 : -1
        }
        break
      }
      case 'leave': {
        // まっすぐ遠ざかる
        s.speed += (10 - s.speed) * Math.min(1, dt * 2)
        s.x += Math.sin(s.yaw) * s.speed * dt
        s.z += Math.cos(s.yaw) * s.speed * dt
        s.y += (-2 - s.y) * Math.min(1, dt)
        break
      }
    }
  }

  /** 突っ込みが終わったあと。まだ回数が残っていれば下がって仕切り直し、なければ去る */
  private afterPass(s: Shark): void {
    s.passes--
    if (s.passes > 0) {
      s.state = 'retreat'
      s.timer = SHARK_RETREAT_TIME
    } else {
      this.leave(s)
    }
  }

  /** 泳ぐ人から遠ざかる向きへ去っていく */
  private leave(s: Shark): void {
    const p = this.player
    s.state = 'leave'
    // 真後ろへ逃げると泳ぐ人と並走になって離れないので、斜め後ろへ
    s.yaw = Math.atan2(s.x - p.x, s.z - p.z - 12)
  }

  /** 目標の場所へ、向きを turnRate までの速さで直しながら進む */
  private steerTo(s: Shark, tx: number, tz: number, speed: number, turnRate: number, dt: number): void {
    const want = Math.atan2(tx - s.x, tz - s.z)
    let diff = want - s.yaw
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    s.yaw += Math.sign(diff) * Math.min(Math.abs(diff), turnRate * dt)
    s.speed += (speed - s.speed) * Math.min(1, dt * 3)
    s.x += Math.sin(s.yaw) * s.speed * dt
    s.z += Math.cos(s.yaw) * s.speed * dt
  }

  // --- 置く・片づける -------------------------------------------------------
  private fill(): void {
    const limit = this.player.z + SPAWN_AHEAD
    while (this.jellyCursor < limit) {
      const zone = zoneAt(this.jellyCursor)
      const [clo, chi] = zone.jellyCount
      const count = this.rng.int(clo, chi)
      const cx = this.rng.range(-LANE + 3, LANE - 3)
      // 群れごとに深さの中心を決める（海面近くの群れもあれば、深いところの群れもある）
      const [dlo, dhi] = zone.jellyDepth
      const cy = this.rng.range(dlo + 2, dhi - 1)
      for (let i = 0; i < count; i++) {
        this.jellies.push({
          id: this.nextId++,
          x: Math.max(-LANE, Math.min(LANE, cx + this.rng.range(-6, 6))),
          y: Math.max(dlo, Math.min(dhi, cy + this.rng.range(-3, 3))),
          z: this.jellyCursor + this.rng.range(-5, 5),
          size: this.rng.range(0.75, 1.35),
          phase: this.rng.range(0, Math.PI * 2),
          kind: this.rng.int(0, 2),
        })
      }
      const [glo, ghi] = zone.jellyGap
      this.jellyCursor += this.rng.range(glo, ghi)
    }
    while (this.pearlCursor < limit) {
      const zone = zoneAt(this.pearlCursor)
      // 3〜5 個の列にすることもある（泳ぐ道しるべになる）
      const n = this.rng.next() < 0.4 ? this.rng.int(3, 5) : 1
      const x = this.rng.range(-LANE + 2, LANE - 2)
      // 6 割は海面、2 割は少し下、2 割は深いところ（潜って取りに行く価値がある）
      const roll = this.rng.next()
      const deepest = Math.max(MAX_DEPTH + 2, zone.floorY + 4)
      const y = roll < 0.6 ? -0.2 : roll < 0.8 ? this.rng.range(-6, -1.5) : this.rng.range(deepest, DEEP_PEARL_DEPTH - 2)
      const value = y < DEEP_PEARL_DEPTH ? DEEP_PEARL_SCORE : PEARL_SCORE
      for (let i = 0; i < n; i++) {
        this.pearls.push({ id: this.nextId++, x, y, z: this.pearlCursor + i * 3, phase: this.rng.range(0, 6), value })
      }
      const [glo, ghi] = zone.pearlGap
      this.pearlCursor += n * 3 + this.rng.range(glo, ghi)
    }
  }

  private cull(): void {
    const behind = this.player.z - DESPAWN_BEHIND
    for (let i = this.jellies.length - 1; i >= 0; i--) if (this.jellies[i].z < behind) this.jellies.splice(i, 1)
    for (let i = this.pearls.length - 1; i >= 0; i--) if (this.pearls[i].z < behind) this.pearls.splice(i, 1)
  }
}
