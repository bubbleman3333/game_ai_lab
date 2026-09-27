// ゲーム 1 回ぶん。街・車・通行人・警察・手配度・ミッション・時刻をまとめて進める。
// three.js にも React にも依存しない（scene/ が描き、components/ が画面に置く）。
//
// 毎フレームやること（update）:
//   1. 一般車（車線を走る）と通行人を進める
//   2. 物理で動く車（自分・パトカー・ぶつけられた車）を 1/120 秒刻みで進め、衝突を解く
//   3. 人をはねたか調べる → 手配度（★）が上がる
//   4. 警察が見ているか調べる → 見られていない時間が続くと手配が解ける
//   5. 自分の周りに車と人を補充し、遠くのものを消す（街全体に置くと重いので、近くだけに置く）

import { CityMap, SEAWALL, nodeX } from './cityMap'
import { MAPS, type MapConfig } from './maps'
import { Missions, roadSpot, sideMarkers, type Marker, type MissionHooks, type MissionStatus } from './missions'
import { CHAPTERS, type Line, type StoryProgress } from './story'
import { Pedestrians, isDown, type Ped } from './pedestrians'
import { PoliceDriver, canSee } from './police'
import { makeRng, pick, type Rng } from './rng'
import { Heli, type Shot } from './heli'
import { LaneDriver, randomLaneSpot, type Obstacle } from './traffic'
import {
  NO_CONTROLS, SPECS, circles, collideVehicles, collideWorld, newBody, overlapping, speedOf, stepVehicle,
  type Body, type Controls, type VehicleSpec, type VehicleType,
} from './vehicle'

export type Role = 'player' | 'traffic' | 'police' | 'parked'

export class Vehicle {
  body: Body
  controls: Controls = { ...NO_CONTROLS }
  lane: LaneDriver | null = null
  police: PoliceDriver | null = null
  health: number
  /** 火が出ている（0 になると爆発） */
  burning = -1
  wrecked = false
  siren = false
  /** ハザード（ぶつけられて止まった車） */
  hazard = false
  braking = false
  /** 海に落ちてからの時間（落ちていなければ −1）。しばらく浮かんでから沈む */
  sinking = -1
  /** 警官が降りている（戻ってくるまで車は動かない） */
  crewOut = false
  /** 警官が戻ったら追跡を始める（職質から逃げられたとき） */
  chaseWhenBack = false
  /** 警官が戻ったら走り去る（職質が終わったとき） */
  leaveWhenBack = false
  /**
   * へこみ（車のローカル座標。x = 左、z = 前、k = 強さ 0〜1）。見た目（scene/carModels.ts）が
   * 車体の頂点を押し込むのに使う。車が消えるまで残る
   */
  dents: { x: number; z: number; k: number }[] = []
  /** クラクションを鳴らしている */
  honking = false
  id: number
  spec: VehicleSpec
  role: Role
  color: number
  constructor(id: number, spec: VehicleSpec, role: Role, color: number, x: number, z: number, yaw: number) {
    this.id = id
    this.spec = spec
    this.role = role
    this.color = color
    this.body = newBody(x, z, yaw)
    this.health = spec.hp
  }
  get physical(): boolean { return this.lane === null }
}

export interface Input {
  throttle: number
  steer: number
  handbrake: boolean
  horn: boolean
  /** 押した瞬間だけ true */
  carjack: boolean
  reset: boolean
  timeSkip: boolean
}

export type GameEvent =
  | { kind: 'crash'; x: number; z: number; impact: number; player: boolean }
  /** 職務質問の始まり・終わり */
  | { kind: 'questioning'; phase: 'start' | 'released' | 'fled' | 'found' }
  /** 車のドアの開け閉め（警官の乗り降り） */
  | { kind: 'door'; x: number; z: number }
  /** 車が海に落ちた */
  | { kind: 'splash'; x: number; z: number; player: boolean }
  /** ヘリからの銃撃 */
  | ({ kind: 'shot' } & Shot)
  | { kind: 'pedHit'; x: number; z: number; speed: number; player: boolean }
  | { kind: 'propBreak'; x: number; z: number; prop: number; player: boolean }
  | { kind: 'explosion'; x: number; z: number }
  | { kind: 'fire'; id: number }
  | { kind: 'stars'; stars: number; up: boolean }
  | { kind: 'busted' }
  | { kind: 'wasted' }
  | { kind: 'respawn' }
  | { kind: 'carjack'; name: string }
  | { kind: 'missionStart'; title: string; story: boolean }
  | { kind: 'missionEnd'; ok: boolean; text: string; reward: number; story: boolean }
  | { kind: 'dialogue'; lines: Line[] }
  /** 物語が 1 つ進んだ（画面が保存する） */
  | { kind: 'story'; progress: StoryProgress; chapterDone: boolean }
  | { kind: 'score'; amount: number; text: string }

/** 手配度（★）の境目。熱（heat）がこの値を超えると 1 つ上がる */
const STAR_HEAT = [0, 30, 150, 350, 650, 1000]
/** ★ごとの追跡するパトカーの台数 */
const COPS_FOR_STARS = [0, 1, 3, 4, 6, 8]
const TRAFFIC_COUNT = 44
/** この秒数止まっていると職務質問が来る */
const QUESTION_AFTER = 25
/** 職務質問の長さ（この秒数じっと待てば終わる） */
const QUESTION_TIME = 9
/** 自分の車が受ける傷の倍率（小さいほど頑丈） */
const PLAYER_ARMOR = 0.3
/** 手配中でなければ、1 秒にこれだけ車が直る（体力の割合） */
const PLAYER_REPAIR = 0.02
/** 見つからないまま、この秒数（+ ★ごとの秒数）逃げ続けると手配が解ける */
const EVADE_BASE = 12
const EVADE_PER_STAR = 5
/** 止まったまま囲まれて、この秒数で逮捕 */
const BUST_SECONDS = 5
const PED_COUNT = 120
const SUB = 1 / 120
/** 夜明け・日暮れの時刻など。1 秒で 1 分進む（1 日 = 24 分） */
export const MINUTES_PER_SECOND = 1

const CAR_COLORS = [0xf2f2f0, 0xe9e9ea, 0x111214, 0x1c1d22, 0x9ea3aa, 0x6b7078, 0x1f2f55, 0x8a1418,
  0x2d4a3a, 0xc9b99a, 0x5a1f2c, 0x3b5f8a, 0xd8d2c4, 0x404448]
const TRAFFIC_TYPES: VehicleType[] = ['sedan', 'sedan', 'hatch', 'hatch', 'suv', 'van', 'taxi', 'sedan', 'hatch', 'police']


export interface Stats {
  pedsHit: number
  carsWrecked: number
  copsWrecked: number
  propsBroken: number
  maxStars: number
  missions: number
}

export class Game {
  readonly map: CityMap
  readonly rng: Rng
  readonly vehicles: Vehicle[] = []
  readonly peds: Pedestrians
  readonly missions: Missions
  /** 倒れた小物（街灯）。1 = 倒れた */
  readonly broken: Uint8Array
  /** 倒れた小物の倒れる向き（見た目用） */
  readonly brokenYaw: Float32Array
  player: Vehicle
  time = 0
  /** 時刻（0〜24 時） */
  clock = 17.2
  heat = 0
  stars = 0
  /** 警察に見られていない時間（手配が解けるまでの目安） */
  evade = 0
  seen = false
  /** 捕まりかけている度合い（0〜1） */
  bust = 0
  score = 0
  combo = 0
  private comboTimer = 0
  state: 'play' | 'busted' | 'wasted' = 'play'
  /** やられた理由（大破・水没） */
  deathReason: 'wreck' | 'water' = 'wreck'
  /** 警察のヘリ（★3 以上で飛んでくる） */
  heli: Heli | null = null
  private stateTimer = 0
  readonly stats: Stats = { pedsHit: 0, carsWrecked: 0, copsWrecked: 0, propsBroken: 0, maxStars: 0, missions: 0 }
  private nextId = 1
  private acc = 0
  private events: GameEvent[] = []
  private obstacles: Obstacle[] = []

  readonly config: MapConfig
  /** 寄り道のミッションの輪 */
  readonly side: Marker[]
  /** 物語の進み具合。この街が今の章の舞台なら、次のミッションの輪が出る */
  progress: StoryProgress
  private storyMarker: Marker | null = null
  /** 雪の街はタイヤが滑る */
  private grip: number
  private trafficCount: number
  private pedCount: number
  /** 病院と警察署（やられた・捕まったあとに出てくる場所） */
  private hospital: [number, number, number]
  private policeHq: [number, number, number]
  private hooks: MissionHooks

  constructor(config: MapConfig = MAPS[0], progress: StoryProgress = { chapter: 0, step: 0 },
              playerType: VehicleType = 'sport', playerColor = 0xc81e2a) {
    this.config = config
    this.progress = { ...progress }
    this.map = new CityMap(config)
    const seed = config.seed
    this.grip = config.theme === 'snow' ? 0.72 : 1
    this.trafficCount = Math.round(TRAFFIC_COUNT * config.density)
    this.pedCount = Math.round(PED_COUNT * config.density)
    const mid = Math.floor(config.blocks / 2)
    this.hospital = roadSpot(mid + 1, mid + 1, 0, 0.4)
    this.policeHq = roadSpot(mid - 2, mid - 2, 1, 0.4)
    const START = roadSpot(mid, mid - 1, 1, 0.3)
    this.clock = config.clock
    this.side = sideMarkers(seed)
    this.hooks = {
      setStars: (n) => this.setStars(n),
      spawnTarget: (type, x, z) => this.spawnTarget(type, x, z),
      targetState: (id) => {
        const v = this.vehicles.find((w) => w.id === id)
        return v ? { x: v.body.x, z: v.body.z, wrecked: v.wrecked } : null
      },
    }
    this.rng = makeRng(seed ^ 0x5bd1e995)
    this.peds = new Pedestrians(this.map, this.rng)
    this.missions = new Missions(this.rng)
    this.broken = new Uint8Array(this.map.props.length)
    this.brokenYaw = new Float32Array(this.map.props.length)
    this.player = this.addVehicle(playerType, 'player', playerColor, START[0], START[1], START[2])
    // 最初から街がにぎわっているように、近くにも置いておく
    for (let k = 0; k < this.trafficCount; k++) this.spawnTraffic(25, 240)
    for (let k = 0; k < this.pedCount; k++) this.peds.spawnNear(this.player.body.x, this.player.body.z, 8, 170)
    this.refreshStoryMarker()
  }

  /** 今の章の舞台がこの街なら、その章の次のミッションの輪を出す */
  private refreshStoryMarker(): void {
    const ch = CHAPTERS[this.progress.chapter]
    this.storyMarker = null
    if (!ch || ch.map !== this.config.id) return
    const step = ch.steps[this.progress.step]
    if (!step) return
    const [x, z] = roadSpot(step.at[0], step.at[1], step.at[2], 0.5)
    this.storyMarker = { x, z, def: step.mission, story: true }
  }

  /** 画面に出す輪（物語 → 寄り道の順） */
  get markers(): Marker[] {
    return this.storyMarker ? [this.storyMarker, ...this.side] : this.side
  }
  get storyTarget(): Marker | null { return this.storyMarker }
  get mission(): MissionStatus | null { return this.missions.active }
  /** ミッションの標的の車の番号（無ければ −1） */
  get targetVehicle(): number { return this.missions.targetVehicle }

  /** 章の始まりの会話（画面を開いたときに流す） */
  chapterIntro(): Line[] {
    const ch = CHAPTERS[this.progress.chapter]
    if (!ch || ch.map !== this.config.id || this.progress.step !== 0) return []
    return ch.intro
  }

  private spawnTarget(type: VehicleType, x: number, z: number): number {
    const v = this.addVehicle(type, 'traffic', type === 'sedan' ? 0x16181c : 0xf0f0f0, x, z, this.rng() * Math.PI * 2)
    v.police = new PoliceDriver()
    v.police.flee = true
    v.health = v.spec.hp * 0.8
    return v.id
  }

  private addVehicle(type: VehicleType, role: Role, color: number, x: number, z: number, yaw: number): Vehicle {
    const spec = this.grip === 1 ? SPECS[type] : { ...SPECS[type], mu: SPECS[type].mu * this.grip }
    const v = new Vehicle(this.nextId++, spec, role, color, x, z, yaw)
    this.vehicles.push(v)
    return v
  }

  private spawnTraffic(min: number, max: number): void {
    const p = this.player.body
    const lane = randomLaneSpot(this.rng, p.x, p.z, min, max)
    if (!lane) return
    const [x, z, yaw] = lane.pose()
    for (const v of this.vehicles) if (Math.hypot(v.body.x - x, v.body.z - z) < 12) return
    const type = pick(this.rng, TRAFFIC_TYPES)
    const color = type === 'taxi' ? 0xf2b705 : type === 'police' ? 0xffffff : pick(this.rng, CAR_COLORS)
    const v = this.addVehicle(type, type === 'police' ? 'police' : 'traffic', color, x, z, yaw)
    lane.halfLen = v.spec.length / 2
    v.lane = lane
  }

  private spawnPolice(): void {
    const p = this.player.body
    const lane = randomLaneSpot(this.rng, p.x, p.z, 110, 200)
    if (!lane) return
    const [x, z, lyaw] = lane.pose()
    if (canSee(this.map, p, { ...p, x, z }, 90)) return // 目の前に湧かないように
    // こちらへ向かう向きで出す（遠ざかる向きだと U ターンから始まってしまう）
    const yaw = Math.sin(lyaw) * (p.x - x) + Math.cos(lyaw) * (p.z - z) < 0 ? lyaw + Math.PI : lyaw
    const v = this.addVehicle('police', 'police', 0xffffff, x, z, yaw)
    this.startChase(v)
    v.body.vx = Math.sin(yaw) * 15
    v.body.vz = Math.cos(yaw) * 15
  }

  private startChase(v: Vehicle): void {
    v.lane = null
    v.police = new PoliceDriver()
    v.siren = true
  }

  /** 車線の運転をやめて物理で動かす（ぶつけられたとき） */
  private detach(v: Vehicle): void {
    if (!v.lane) return
    v.lane = null
    v.controls = { throttle: -0.4, steer: 0, handbrake: false }
    v.hazard = true
  }

  // --- 手配度 --------------------------------------------------------------------

  addHeat(amount: number): void {
    if (this.state !== 'play') return
    this.heat = Math.min(this.heat + amount, STAR_HEAT[5] + 200)
    this.refreshStars()
    this.evade = 0
  }

  setStars(n: number): void {
    this.heat = Math.max(this.heat, STAR_HEAT[n] + 1)
    this.refreshStars()
  }

  private refreshStars(): void {
    let s = 0
    for (let k = 1; k < STAR_HEAT.length; k++) if (this.heat >= STAR_HEAT[k]) s = k
    if (s !== this.stars) {
      this.events.push({ kind: 'stars', stars: s, up: s > this.stars })
      this.stars = s
      this.stats.maxStars = Math.max(this.stats.maxStars, s)
    }
  }

  private clearWanted(): void {
    this.heat = 0
    this.evade = 0
    if (this.stars !== 0) this.events.push({ kind: 'stars', stars: 0, up: false })
    this.stars = 0
    for (const v of this.vehicles) {
      if (v.role === 'police' && v.police) { v.siren = false; v.police = null; v.controls = { ...NO_CONTROLS } }
    }
  }

  private addScore(amount: number, text: string): void {
    this.score = Math.max(0, this.score + amount)
    this.events.push({ kind: 'score', amount, text })
  }

  // --- 毎フレーム ---------------------------------------------------------------------

  update(dt: number, input: Input): GameEvent[] {
    this.events = []
    dt = Math.min(dt, 0.1)
    this.time += dt
    this.clock = (this.clock + (dt * MINUTES_PER_SECOND) / 60 + (input.timeSkip ? 1 : 0)) % 24
    const me = this.player

    if (this.state === 'play') {
      me.controls = { throttle: input.throttle, steer: input.steer, handbrake: input.handbrake }
      me.honking = input.horn
      if (input.carjack) this.tryCarjack()
      if (input.reset) this.resetToRoad()
      this.updateQuestioning(dt)
    } else {
      me.controls = { throttle: 0, steer: 0, handbrake: true }
      me.honking = false
      this.stateTimer -= dt
      if (this.stateTimer <= 0) this.respawn()
    }

    this.buildObstacles()
    for (let k = 0; k < this.vehicles.length; k++) {
      const v = this.vehicles[k]
      if (v.lane) {
        const before = v.lane.speed
        this.obstacles[k].self = true // 自分自身は障害物にしない
        v.lane.update(dt, this.time, this.obstacles, this.rng, v.body)
        this.obstacles[k].self = false
        v.braking = v.lane.speed < before - 0.02 || v.lane.speed < 0.3
        v.honking = v.lane.blocked > 2.5 && v.lane.blocked % 4 < 0.5 && this.nearPlayer(v, 40)
      } else if (v.crewOut && !v.wrecked) {
        v.controls = { throttle: speedOf(v.body) > 0.3 ? -1 : 0, steer: 0, handbrake: true }
        v.braking = true
      } else if (v.police && !v.wrecked) {
        const sees = canSee(this.map, v.body, me.body, 110)
        v.police.aggression = 0.9 + this.stars * 0.06
        v.controls = v.police.update(dt, v.body, me.body, sees)
        v.braking = v.controls.throttle < 0
      } else if (v !== me) {
        // 乗り手のいない車（ぶつけられた・乗り捨てた）: ブレーキをかけて止まる
        v.controls = { throttle: speedOf(v.body) > 0.5 ? -0.5 : 0, steer: 0, handbrake: false }
        v.braking = false
      } else {
        v.braking = me.controls.throttle < 0 && speedOf(me.body) > 0.5
      }
    }

    this.peds.update(dt, this.time)
    this.scarePeds(dt)

    // 物理（細かい刻みで）
    this.acc += dt
    let steps = 0
    while (this.acc >= SUB && steps < 12) {
      this.physicsStep()
      this.acc -= SUB
      steps++
    }
    if (steps >= 12) this.acc = 0

    this.updateDamage(dt)
    this.updateSea(dt)
    this.updateHeli(dt)
    this.updateCrews()
    this.updateWanted(dt)
    this.updateMission(dt)
    this.comboTimer -= dt
    if (this.comboTimer <= 0) this.combo = 0
    this.populate()
    return this.events
  }

  private nearPlayer(v: Vehicle, r: number): boolean {
    return Math.hypot(v.body.x - this.player.body.x, v.body.z - this.player.body.z) < r
  }

  private buildObstacles(): void {
    const obs = this.obstacles
    obs.length = 0
    for (const v of this.vehicles) {
      obs.push({ x: v.body.x, z: v.body.z, vx: v.body.vx, vz: v.body.vz, radius: v.spec.width / 2, half: v.spec.length / 2 })
    }
    // 車道に出ている人だけ（歩道の人まで見ると、歩道ぞいの車がずっと止まってしまう）
    for (const p of this.peds.list) {
      if (p.mode === 'walk' || p.mode === 'wait') continue
      if (this.map.surface(p.x, p.z) !== 'road') continue
      obs.push({ x: p.x, z: p.z, vx: p.vx, vz: p.vz, radius: 0.5, half: 0.8 })
    }
  }

  private physicsStep(): void {
    const vs = this.vehicles
    for (const v of vs) {
      if (v.lane) continue
      if (v.sinking >= 0) continue // 海の中は物理で動かさない（updateSea で沈める）
      stepVehicle(v.body, v.spec, v.wrecked ? { throttle: -1, steer: 0, handbrake: true } : v.controls, SUB)
      const hit = collideWorld(v.body, v.spec, this.map, this.broken)
      if (hit) {
        const isMe = v === this.player
        if (hit.brokeProp >= 0) {
          this.brokenYaw[hit.brokeProp] = Math.atan2(v.body.vx, v.body.vz)
          this.events.push({ kind: 'propBreak', x: hit.x, z: hit.z, prop: hit.brokeProp, player: isMe })
          if (isMe) { this.stats.propsBroken++; this.addScore(10, '街灯') }
        } else if (hit.impact > 3) {
          this.damage(v, (hit.impact - 3) * 3.2)
          this.dent(v, hit.x, hit.z, hit.impact)
          this.events.push({ kind: 'crash', x: hit.x, z: hit.z, impact: hit.impact, player: isMe })
        }
      }
    }
    // 車どうし
    for (let a = 0; a < vs.length; a++) {
      for (let b = a + 1; b < vs.length; b++) {
        const A = vs[a], B = vs[b]
        if (A.lane && B.lane) continue // 車線どうしは互いに避けて走る
        if (A.lane || B.lane) {
          if (!overlapping(A.body, A.spec, B.body, B.spec)) continue
          this.detach(A)
          this.detach(B)
        }
        const r = collideVehicles(A.body, A.spec, B.body, B.spec)
        if (r.impact <= 0) continue
        const involvesMe = A === this.player || B === this.player
        if (r.impact > 2.5) {
          const dmg = (r.impact - 2.5) * 3
          this.damage(A, dmg * (B.spec.mass / A.spec.mass) ** 0.5)
          this.damage(B, dmg * (A.spec.mass / B.spec.mass) ** 0.5)
          this.dent(A, r.x, r.z, r.impact)
          this.dent(B, r.x, r.z, r.impact)
          this.events.push({ kind: 'crash', x: r.x, z: r.z, impact: r.impact, player: involvesMe })
          if (involvesMe) {
            const other = A === this.player ? B : A
            if (other.role === 'police' && !other.wrecked) this.addHeat(r.impact > 6 ? 30 : 8)
            else if (r.impact > 6) this.addHeat(this.policeWatching() ? 20 : 0)
            this.scareAround(r.x, r.z, 18)
          }
        }
      }
    }
    this.hitPeds()
  }

  private hitPeds(): void {
    const circ: [number, number][] = [[0, 0], [0, 0], [0, 0]]
    for (const v of this.vehicles) {
      const sp = speedOf(v.body)
      if (sp < 0.6) continue
      circles(v.body, v.spec, circ)
      const reach = v.spec.length / 2 + 1
      for (const p of this.peds.list) {
        if (p.mode === 'fly' || p.mode === 'stagger' || (p.mode === 'officer' && v.police !== null)) continue
        if (Math.abs(p.x - v.body.x) > reach || Math.abs(p.z - v.body.z) > reach) continue
        if (p.mode === 'down') continue
        const min = v.spec.width / 2 + 0.3
        let touch = false
        for (const [cx, cz] of circ) if ((p.x - cx) ** 2 + (p.z - cz) ** 2 < min * min) { touch = true; break }
        if (!touch) continue
        if (v.lane) { continue } // 一般車は手前で止まるので、触れても押しのけない
        const wasOfficer = p.officer !== null
        if (p.mode === 'officer') p.mode = 'walk'
        p.officer = null
        this.peds.knock(p, v.body.vx, v.body.vz, sp)
        const isMe = v === this.player
        if (isMe && wasOfficer && sp >= 3) { this.addHeat(140); this.addScore(100, '警官') }
        this.events.push({ kind: 'pedHit', x: p.x, z: p.z, speed: sp, player: isMe })
        this.scareAround(p.x, p.z, 22)
        if (isMe && sp >= 3) {
          this.stats.pedsHit++
          this.combo = this.comboTimer > 0 ? this.combo + 1 : 1
          this.comboTimer = 3.5
          this.addScore(50 * this.combo, this.combo > 1 ? `${this.combo} 連続` : 'はねた')
          this.addHeat(this.policeWatching() ? 60 : 38)
        }
        // 人をはねると少しだけ減速する
        v.body.vx *= 0.97
        v.body.vz *= 0.97
      }
    }
  }

  /** パトカーがこちらを見ているか（見られていると手配度が上がりやすい） */
  private policeWatching(): boolean {
    for (const v of this.vehicles) {
      if (v.role !== 'police' || v.wrecked) continue
      if (canSee(this.map, v.body, this.player.body, 70)) return true
    }
    return false
  }

  private scareAround(x: number, z: number, r: number): void {
    for (const p of this.peds.list) {
      if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r) this.peds.scare(p, x, z)
    }
  }

  /** 危ない走り（歩道を飛ばす車・クラクション）に人が逃げる */
  private scarePeds(dt: number): void {
    const me = this.player
    const b = me.body
    const sp = speedOf(b)
    const onWalk = this.map.surface(b.x, b.z) !== 'road'
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw)
    for (const p of this.peds.list) {
      if (isDown(p) || p.mode === 'flee' || p.mode === 'stagger') continue
      const dx = p.x - b.x, dz = p.z - b.z
      if (Math.abs(dx) > 20 || Math.abs(dz) > 20) continue
      const d = Math.hypot(dx, dz)
      const ahead = dx * fx + dz * fz
      if (me.honking && d < 18 && ahead > -3) this.peds.scare(p, b.x, b.z)
      else if (onWalk && sp > 5 && d < 9 && ahead > -2) this.peds.scare(p, b.x, b.z)
      else if (sp > 8 && d < 4.5 && ahead > 0) this.peds.scare(p, b.x, b.z)
    }
    void dt
  }

  /** ぶつかった場所（世界座標）を車のローカル座標にして、へこみとして覚える */
  private dent(v: Vehicle, wx: number, wz: number, impact: number): void {
    if (impact < 3.5) return
    const dx = wx - v.body.x, dz = wz - v.body.z
    const sn = Math.sin(v.body.yaw), cs = Math.cos(v.body.yaw)
    const k = Math.min(1, (impact - 3) / 16)
    const x = dx * cs - dz * sn // 左が正
    const z = dx * sn + dz * cs // 前が正
    // 近くのへこみは 1 つにまとめて深くする（数が増えすぎないように）
    const near = v.dents.find((d) => Math.hypot(d.x - x, d.z - z) < 0.6)
    if (near) near.k = Math.min(1.6, near.k + k * 0.6)
    else if (v.dents.length < 24) v.dents.push({ x, z, k })
  }

  private damage(v: Vehicle, amount: number): void {
    if (v.wrecked || amount <= 0) return
    // 一般車・パトカーは壊れやすくしてある（ぶつけて壊しまくれるように）
    if (v !== this.player) amount *= 1.7
    // 自分の車はかなり頑丈にしてある（すぐ壊れるより、警察から長く逃げ回るほうが面白いので）
    if (v === this.player) amount *= PLAYER_ARMOR
    v.health -= amount
    if (v.health <= 0 && v.burning < 0) {
      v.health = 0
      v.burning = v === this.player ? 5 : 4.5
      this.events.push({ kind: 'fire', id: v.id })
    }
  }

  private updateDamage(dt: number): void {
    // 追われていないあいだは少しずつ直る（街を流しているうちに次の逃走に備えられる）
    const me = this.player
    if (this.stars === 0 && me.burning < 0 && !me.wrecked) {
      me.health = Math.min(me.spec.hp, me.health + me.spec.hp * PLAYER_REPAIR * dt)
    }
    for (const v of this.vehicles) {
      if (v.burning < 0 || v.wrecked) continue
      v.burning -= dt
      if (v.burning <= 0) this.explode(v)
    }
  }

  private explode(v: Vehicle): void {
    v.wrecked = true
    v.burning = -1
    v.siren = false
    v.police = null
    v.lane = null
    v.hazard = false
    const { x, z } = v.body
    this.events.push({ kind: 'explosion', x, z })
    v.body.vx *= 0.3; v.body.vz *= 0.3
    // 周りの車を吹き飛ばし、傷つける（連鎖して爆発することもある）
    for (const o of this.vehicles) {
      if (o === v) continue
      const dx = o.body.x - x, dz = o.body.z - z
      const d = Math.hypot(dx, dz)
      if (d > 11) continue
      this.detach(o)
      const k = (1 - d / 11) * 9
      o.body.vx += (dx / (d || 1)) * k
      o.body.vz += (dz / (d || 1)) * k
      o.body.r += (this.rng() - 0.5) * k * 0.4
      this.damage(o, (1 - d / 11) * 70)
    }
    for (const p of this.peds.list) {
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < 8 && p.mode !== 'down') this.peds.blast(p, x, z, 30)
      else if (d < 30) this.peds.scare(p, x, z, 1.4)
    }
    this.map.props.forEach((pr, i) => {
      if (!pr.breakable || this.broken[i]) return
      if (Math.abs(pr.x - x) < 6 && Math.abs(pr.z - z) < 6) {
        this.broken[i] = 1
        this.brokenYaw[i] = Math.atan2(pr.x - x, pr.z - z)
      }
    })
    if (v === this.player) {
      this.wasted()
    } else {
      const byMe = Math.hypot(x - this.player.body.x, z - this.player.body.z) < 30
      if (v.role === 'police') {
        this.stats.copsWrecked++
        if (byMe) { this.addHeat(80); this.addScore(300, 'パトカー撃破') }
      } else {
        this.stats.carsWrecked++
        if (byMe) { this.addScore(150, '爆破'); this.addHeat(this.policeWatching() ? 40 : 10) }
      }
    }
  }

  private updateWanted(dt: number): void {
    if (this.state !== 'play') return
    const me = this.player
    // 追跡の台数を揃える
    const chasing = this.vehicles.filter((v) => v.role === 'police' && v.police && !v.wrecked)
    if (this.stars > 0) {
      // 近くを巡回中のパトカーは追跡に加わる
      for (const v of this.vehicles) {
        if (v.role === 'police' && v.lane && chasing.length < COPS_FOR_STARS[this.stars] &&
            canSee(this.map, v.body, me.body, 80)) {
          this.startChase(v)
          chasing.push(v)
        }
      }
      if (chasing.length < COPS_FOR_STARS[this.stars] && this.rng() < dt * 0.8) this.spawnPolice()
    }

    // 見られているか
    this.seen = false
    if (this.stars > 0) {
      for (const v of chasing) {
        if (canSee(this.map, v.body, me.body, 95)) { this.seen = true; break }
      }
      // ヘリのサーチライトに捕まっている（真上近くにいる）
      if (this.heli && !this.heli.leaving && this.heli.horizontalDistance(me.body) < 55) this.seen = true
      if (this.seen) this.evade = 0
      else {
        this.evade += dt
        if (this.evade > EVADE_BASE + this.stars * EVADE_PER_STAR) {
          this.clearWanted()
          this.addScore(100 * Math.max(1, this.stats.maxStars), '逃げ切った')
        }
      }
    }

    // 逮捕: 自分が止まっていると、近くのパトカーから警官が降りて走ってくる。
    // 警官が車のそばに来て初めて逮捕が進む（その前に走り出せば、警官はパトカーへ戻る）
    const slow = this.stars > 0 && speedOf(me.body) < 1.5
    if (slow) {
      for (const v of chasing) {
        if (!v.crewOut && speedOf(v.body) < 3 && Math.hypot(v.body.x - me.body.x, v.body.z - me.body.z) < 22) {
          this.dropCrew(v, 2, true)
        }
      }
    }
    let close = false
    for (const p of this.peds.list) {
      const o = p.officer
      if (!o) continue
      const car = this.vehicles.find((v) => v.id === o.car)
      if (o.phase === 'out' && car && !this.questioner) {
        if (!slow && speedOf(me.body) > 4) this.crewBack(car, true)
        else {
          // 運転席側と助手席側から回り込む
          const k = this.peds.list.filter((q) => q.officer?.car === o.car).indexOf(p)
          this.officerTo(p, me, k === 0 ? 1 : -1, true)
          if (Math.hypot(p.x - me.body.x, p.z - me.body.z) < 2.9) close = true
        }
      }
    }
    this.bust = close ? this.bust + dt / BUST_SECONDS : Math.max(0, this.bust - dt * 0.7)
    if (this.bust >= 1) this.busted()
  }

  /** 護岸を越えて海に落ちた車: しばらく浮かんで、ゆっくり沈む */
  private updateSea(dt: number): void {
    for (let k = this.vehicles.length - 1; k >= 0; k--) {
      const v = this.vehicles[k]
      const b = v.body
      const out = Math.abs(b.x) > SEAWALL + 0.8 || Math.abs(b.z) > SEAWALL + 0.8
      if (v.sinking < 0) {
        if (!out) continue
        v.sinking = 0
        v.lane = null
        v.police = null
        v.siren = false
        this.events.push({ kind: 'splash', x: b.x, z: b.z, player: v === this.player })
        if (v === this.player && this.state === 'play') this.drown()
      }
      v.sinking += dt
      // 落ちた勢いで少し進み、波に揺られながら沈む
      b.vx *= Math.exp(-dt * 1.2)
      b.vz *= Math.exp(-dt * 1.2)
      b.x += b.vx * dt
      b.z += b.vz * dt
      const t = v.sinking
      b.y = t < 0.6 ? -1.6 * (t / 0.6) ** 2 + 0.2 : t < 4 ? -1.35 + Math.sin(t * 2.2) * 0.12 : -1.35 - (t - 4) * 0.5
      b.accLong = Math.sin(t * 1.7) * 3
      b.accLat = Math.cos(t * 1.3) * 3
      b.r = 0
      if (t > 12 && v !== this.player) this.vehicles.splice(k, 1)
    }
  }

  private drown(): void {
    this.deathReason = 'water'
    this.player.burning = -1
    this.state = 'wasted'
    this.stateTimer = 5
    const r = this.missions.fail()
    if (r) this.endMission(r)
    this.events.push({ kind: 'wasted' })
    this.addScore(-Math.round(this.score * 0.05), '引き上げ代')
  }

  /** 警察のヘリ: ★3 で飛んできて、★4 からは撃ってくる */
  private updateHeli(dt: number): void {
    const me = this.player.body
    if (this.stars >= 3 && this.state === 'play') {
      if (!this.heli || this.heli.leaving) {
        if (!this.heli) {
          const a = this.rng() * Math.PI * 2
          this.heli = new Heli(me.x + Math.sin(a) * 260, me.z + Math.cos(a) * 260)
        }
        this.heli.leaving = false
      }
    } else if (this.heli) {
      this.heli.leaving = true
    }
    const h = this.heli
    if (!h) return
    const shots = h.update(dt, me, this.stars >= 4 && this.state === 'play', this.rng)
    for (const s of shots) {
      this.events.push({ kind: 'shot', ...s })
      if (s.hit) this.damage(this.player, 5)
      else this.scareAround(s.tx, s.tz, 10)
    }
    if (h.leaving && h.horizontalDistance(me) > 450) this.heli = null
  }

  private busted(): void {
    this.state = 'busted'
    this.stateTimer = 4.5
    this.bust = 0
    const r = this.missions.fail()
    if (r) this.endMission(r)
    this.events.push({ kind: 'busted' })
    this.addScore(-Math.round(this.score * 0.1), '保釈金')
  }

  private wasted(): void {
    this.deathReason = 'wreck'
    this.state = 'wasted'
    this.stateTimer = 3
    const r = this.missions.fail()
    if (r) this.endMission(r)
    this.events.push({ kind: 'wasted' })
    this.addScore(-Math.round(this.score * 0.05), '修理代')
  }

  private respawn(): void {
    // 大破のときは、その場の近くの道路で新しい車に乗り換えて続ける（遠くへ飛ばさない）
    let at = this.state === 'busted' ? this.policeHq : this.hospital
    if (this.state === 'wasted') {
      const b = this.player.body
      const lane = randomLaneSpot(this.rng, Math.max(-SEAWALL + 60, Math.min(SEAWALL - 60, b.x)),
                                  Math.max(-SEAWALL + 60, Math.min(SEAWALL - 60, b.z)), 20, 90)
      if (lane) at = lane.pose()
    }
    const old = this.player
    old.role = 'parked'
    this.player = this.addVehicle(old.wrecked ? 'sport' : old.spec.type, 'player',
                                  old.wrecked ? 0xc81e2a : old.color, at[0], at[1], at[2])
    this.clearWanted()
    // 追っていたパトカーは消す（出てきた先で待ち伏せされないように）
    for (let k = this.vehicles.length - 1; k >= 0; k--) {
      const v = this.vehicles[k]
      if (v.role === 'police' && !v.lane) this.vehicles.splice(k, 1)
      else if (v !== this.player && Math.hypot(v.body.x - at[0], v.body.z - at[1]) < 10) this.vehicles.splice(k, 1)
    }
    this.state = 'play'
    this.events.push({ kind: 'respawn' })
  }

  // --- 職務質問 --------------------------------------------------------------------------
  /** 止まっている時間 */
  private idle = 0
  /** 職質に来たパトカー（来ていなければ null） */
  private questioner: Vehicle | null = null
  /** 職質が始まってからの時間（まだ着いていなければ −1） */
  private questionT = -1
  get questioning(): boolean { return this.questionT >= 0 }

  /**
   * 長く止まっていると、巡回のパトカーが寄ってきて職務質問される。
   *   待っていれば解放（たまに車から不審物が見つかって手配）、途中で走り去ると手配 ★1
   */
  private updateQuestioning(dt: number): void {
    const me = this.player
    const sp = speedOf(me.body)
    const busy = this.stars > 0 || this.missions.active !== null
    this.idle = sp < 0.8 && !busy ? this.idle + dt : 0
    const q = this.questioner
    if (q && (q.wrecked || !this.vehicles.includes(q))) { this.endQuestion(null); return }
    if (!q) {
      if (this.idle > QUESTION_AFTER) this.callQuestioner()
      return
    }
    const d = Math.hypot(q.body.x - me.body.x, q.body.z - me.body.z)
    if (this.questionT < 0) {
      // 近づいてくるところ。着く前に走り去れば何も起きない
      if (sp > 6 && d > 25) { this.endQuestion(null); return }
      if (d < 11) {
        this.questionT = 0
        q.police = null
        q.hazard = true
        this.dropCrew(q, 1, false)
        this.events.push({ kind: 'questioning', phase: 'start' })
        this.events.push({ kind: 'dialogue', lines: [
          { who: '警察官', text: 'すみません、ちょっといいですか。免許証を見せてもらえます？' },
          { who: '警察官', text: 'このあたりで事故が続いてましてね。少しお話を聞かせてください' },
        ] })
      }
      return
    }
    this.questionT += dt
    for (const p of this.peds.list) if (p.officer?.car === q.id && p.officer.phase === 'out') this.officerTo(p, me, 1, false)
    if (sp > 5 && d > 9) {
      // 振り切って逃げた
      this.events.push({ kind: 'questioning', phase: 'fled' })
      this.events.push({ kind: 'dialogue', lines: [{ who: '警察官', text: '待ちなさい！　止まりなさい！' }] })
      const cop = q
      this.endQuestion(null)
      this.crewBack(cop, true)
      cop.chaseWhenBack = true
      this.setStars(1)
      return
    }
    if (this.questionT > QUESTION_TIME) {
      if (this.rng() < 0.3) {
        this.events.push({ kind: 'questioning', phase: 'found' })
        this.events.push({ kind: 'dialogue', lines: [
          { who: '警察官', text: '……トランクの中のこれは何ですか？　署まで来てもらいます' },
          { who: 'レン', text: '（まずい。逃げるしかない）' },
        ] })
        const cop = q
        this.endQuestion(null)
        this.crewBack(cop, false)
        cop.chaseWhenBack = true
        this.setStars(2)
      } else {
        this.events.push({ kind: 'questioning', phase: 'released' })
        this.events.push({ kind: 'dialogue', lines: [{ who: '警察官', text: 'ご協力ありがとうございました。安全運転でお願いしますね' }] })
        this.endQuestion(q)
      }
    }
  }

  private callQuestioner(): void {
    const p = this.player.body
    // 近くを巡回しているパトカーがいればそれを、いなければ少し離れた道路に出す
    let cop = this.vehicles.find((v) => v.role === 'police' && v.lane && Math.hypot(v.body.x - p.x, v.body.z - p.z) < 200) ?? null
    if (!cop) {
      const lane = randomLaneSpot(this.rng, p.x, p.z, 90, 170)
      if (!lane) return
      const [x, z, yaw] = lane.pose()
      cop = this.addVehicle('police', 'police', 0xffffff, x, z, yaw)
    }
    cop.lane = null
    cop.police = new PoliceDriver()
    cop.police.approach = true
    cop.siren = false
    this.questioner = cop
    this.questionT = -1
    this.idle = 0
  }

  /** 職質を終える。release に渡したパトカーは、警官が乗り込んだら走り去る */
  private endQuestion(release: Vehicle | null): void {
    if (release) {
      this.crewBack(release, false)
      release.leaveWhenBack = true
    }
    this.questioner = null
    this.questionT = -1
    this.idle = 0
  }

  // --- 警官の乗り降り ------------------------------------------------------------------------

  /** パトカーから n 人降ろす（1 人目は運転席＝右側、2 人目は助手席＝左側から） */
  private dropCrew(car: Vehicle, n: number, run: boolean): void {
    car.crewOut = true
    const b = car.body
    const lx = Math.cos(b.yaw), lz = -Math.sin(b.yaw) // 左
    for (let k = 0; k < n; k++) {
      const side = k === 0 ? -1 : 1 // 右ハンドル: 運転席は右
      const x = b.x + lx * side * (car.spec.width / 2 + 0.45) + Math.sin(b.yaw) * 0.3
      const z = b.z + lz * side * (car.spec.width / 2 + 0.45) + Math.cos(b.yaw) * 0.3
      const p = this.peds.addOfficer(x, z, car.id)
      p.officer!.run = run
      this.events.push({ kind: 'door', x, z })
    }
  }

  /** 警官を相手の車のそばへ向かわせる（side: 1 = 運転席側、−1 = 反対側） */
  private officerTo(p: Ped, target: Vehicle, side: number, run: boolean): void {
    const b = target.body
    const rx = -Math.cos(b.yaw), rz = Math.sin(b.yaw) // 右（運転席側）
    const off = target.spec.width / 2 + 0.7
    p.tx = b.x + rx * off * side + Math.sin(b.yaw) * 0.4
    p.tz = b.z + rz * off * side + Math.cos(b.yaw) * 0.4
    p.officer!.run = run
    p.officer!.face = Math.atan2(b.x - p.tx, b.z - p.tz)
  }

  /** 警官をパトカーへ戻らせる */
  private crewBack(car: Vehicle, run: boolean): void {
    for (const p of this.peds.list) {
      if (p.officer?.car !== car.id) continue
      p.officer.phase = 'back'
      p.officer.run = run
    }
  }

  /** 戻った警官を乗せる。全員乗ったら、待っていた動き（追跡・走り去る）を始める */
  private updateCrews(): void {
    for (const p of this.peds.list) {
      const o = p.officer
      if (!o) continue
      const car = this.vehicles.find((v) => v.id === o.car)
      if (!car || car.wrecked) {
        // パトカーが壊れた・消えた: ただの人として逃げる
        p.officer = null
        p.mode = 'walk'
        this.peds.scare(p, p.x - 1, p.z)
        continue
      }
      if (o.phase !== 'back') continue
      const b = car.body
      p.tx = b.x + Math.cos(b.yaw) * (car.spec.width / 2 + 0.4) * (p.x - b.x > 0 ? 1 : -1)
      p.tz = b.z
      if (Math.hypot(p.x - b.x, p.z - b.z) < car.spec.width / 2 + 0.8) {
        this.events.push({ kind: 'door', x: p.x, z: p.z })
        p.officer = null
        p.mode = 'down'
        p.downTime = 1e9 // 乗り込んだ人は次の掃除で消える
      }
    }
    this.peds.remove((q: Ped) => q.mode === 'down' && q.downTime >= 1e9)
    for (const car of this.vehicles) {
      if (!car.crewOut) continue
      if (this.peds.list.some((p) => p.officer?.car === car.id)) continue
      car.crewOut = false
      if (car.chaseWhenBack) { car.chaseWhenBack = false; this.startChase(car) }
      if (car.leaveWhenBack) {
        car.leaveWhenBack = false
        car.hazard = false
        car.police = null
        car.role = 'parked'
      }
    }
  }

  private tryCarjack(): void {
    const me = this.player
    if (speedOf(me.body) > 4) return
    let best: Vehicle | null = null
    let bestD = 7
    for (const v of this.vehicles) {
      if (v === me || v.wrecked || v.burning >= 0 || v.sinking >= 0) continue
      const d = Math.hypot(v.body.x - me.body.x, v.body.z - me.body.z)
      if (d < bestD) { bestD = d; best = v }
    }
    if (!best) return
    me.role = 'parked'
    me.controls = { ...NO_CONTROLS }
    me.honking = false
    const wasCop = best.role === 'police'
    best.lane = null
    best.police = null
    best.role = 'player'
    best.hazard = false
    best.siren = false
    this.player = best
    this.events.push({ kind: 'carjack', name: best.spec.name })
    this.scareAround(best.body.x, best.body.z, 15)
    if (wasCop) this.addHeat(160)
    else if (this.policeWatching()) this.addHeat(35)
  }

  /** 建物に挟まったとき用: いちばん近い道路の上へ戻す */
  private resetToRoad(): void {
    const b = this.player.body
    if (speedOf(b) > 3) return
    const [i, dx] = CityMap.nearestLine(b.x)
    const [j, dz] = CityMap.nearestLine(b.z)
    // 今いる側の車線に置き、その車線の進む向き（左側通行）に向ける
    if (dx < dz) {
      const side = b.x >= nodeX(i) ? 1 : -1
      b.x = nodeX(i) + side * 3.5
      b.yaw = side > 0 ? 0 : Math.PI
    } else {
      const side = b.z >= nodeX(j) ? 1 : -1
      b.z = nodeX(j) + side * 3.5
      b.yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2
    }
    b.vx = b.vz = b.r = 0
  }

  private updateMission(dt: number): void {
    if (this.state !== 'play') return
    const b = this.player.body
    const m = this.missions.touched(this.markers, b.x, b.z)
    if (m) {
      if (m.story) {
        const step = CHAPTERS[this.progress.chapter].steps[this.progress.step]
        this.events.push({ kind: 'dialogue', lines: step.before })
      }
      const started = this.missions.start(m.def, m.story, b.x, b.z, this.stats.pedsHit, this.hooks)
      this.events.push({ kind: 'missionStart', title: started.def.title, story: m.story })
    }
    const r = this.missions.update(dt, b.x, b.z, this.stats.pedsHit, this.stars, this.hooks)
    if (r) this.endMission(r)
  }

  private endMission(r: { ok: boolean; reward: number; text: string; story: boolean }): void {
    this.events.push({ kind: 'missionEnd', ...r })
    if (!r.ok) return
    this.stats.missions++
    this.addScore(r.reward, r.text)
    if (!r.story) return
    // 物語を 1 つ進める
    const ch = CHAPTERS[this.progress.chapter]
    const lines = [...ch.steps[this.progress.step].after]
    this.progress = { ...this.progress, step: this.progress.step + 1 }
    let chapterDone = false
    if (this.progress.step >= ch.steps.length) {
      lines.push(...ch.outro)
      this.progress = { chapter: this.progress.chapter + 1, step: 0 }
      chapterDone = true
    }
    this.events.push({ kind: 'dialogue', lines })
    this.events.push({ kind: 'story', progress: { ...this.progress }, chapterDone })
    this.refreshStoryMarker()
  }

  /** 自分の周りに車と人を補充し、遠くのものを消す */
  private populate(): void {
    const p = this.player.body
    for (let k = this.vehicles.length - 1; k >= 0; k--) {
      const v = this.vehicles[k]
      if (v === this.player) continue
      const d = Math.hypot(v.body.x - p.x, v.body.z - p.z)
      const limit = v.police ? 380 : v.wrecked || v.hazard || v.role === 'parked' ? 600 : 270
      // 引っかかって動けないパトカーは、見えないところにいれば消して出し直す
      const stuckCop = v.role === 'police' && v.police !== null && v.police.stuckTime > 6 && d > 60
      if (stuckCop || d > limit || Math.abs(v.body.x) > SEAWALL + 50 || Math.abs(v.body.z) > SEAWALL + 50) this.vehicles.splice(k, 1)
    }
    const traffic = this.vehicles.filter((v) => v.lane).length
    for (let k = 0; k < 2 && traffic + k < this.trafficCount; k++) this.spawnTraffic(140, 250)

    this.peds.remove((q: Ped) => {
      const d = Math.hypot(q.x - p.x, q.z - p.z)
      return d > 200 || (q.mode === 'down' && (q.downTime > 60 || d > 130))
    })
    const alive = this.peds.list.length
    for (let k = 0; k < 3 && alive + k < this.pedCount; k++) this.peds.spawnNear(p.x, p.z, 70, 175)
  }
}
