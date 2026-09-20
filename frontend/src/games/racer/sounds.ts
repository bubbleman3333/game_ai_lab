// レースの音。音声ファイルは使わず、Web Audio でその場で作る（土台は lib/sound.ts）。
//
// 2 種類ある:
//   鳴らしっぱなしの音  エンジン・風切り音・タイヤの音。毎フレーム update() で変え続ける
//   単発の音            カウントダウン・周回・着地・トリックなど。出来事のときに 1 回鳴らす
//
// エンジンが単調にならないように、次を重ねている。
//   ギア      速度から 5 段のギアを出して音程を決める。速度に比例させるだけだと、
//             ずっと同じ音がだらだら上がるだけで速く感じない
//   4 層      主音・わずかにずらした音（うなりで厚みが出る）・オクターブ下・高音の唸り
//   排気の脈  回転に合わせて音量を細かく揺らす（「ボボボ」という脈）
//   揺らぎ    ゆっくりした微妙な音程のぶれ。完全に一定だと機械音に聞こえる
//   シフト    ギアが変わる瞬間だけ音量を落とす（ガクンと切り替わる感じ）
//   レブ      最高段で回しきると音が途切れる（頭打ち感）

import { sound, type Drone } from '../../lib/sound'

const GEARS = 5 // いくつギアがあるか
const IDLE = 0.55 // ギアに入った直後の音程の低さ（1 で切り替え直前と同じ）
const ENGINE_BASE = 92 // 1 速に入った直後のエンジンの周波数（Hz）

// 路面の種類（engine/course.ts の KIND_* と同じ番号）
export const SURFACE_NORMAL = 0
export const SURFACE_BOOST = 1
export const SURFACE_DIRT = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** 速度から「エンジンの回り具合」を出す。戻り値: [回り具合, 何速か, そのギアの中での位置] */
function revs(speed: number, vmax: number): [number, number, number] {
  const t = clamp(speed / Math.max(vmax, 1), 0, 1.35)
  const gear = Math.min(Math.floor(t * GEARS), GEARS - 1)
  const within = t * GEARS - gear
  return [IDLE + within * (1 - IDLE) * 1.6, gear, within]
}

export interface EngineState {
  /** 速さ（m/s） */
  speed: number
  /** その車の最高速（m/s） */
  vmax: number
  /** アクセル（-1〜1） */
  throttle: number
  /** 横滑りの速さ（m/s）。大きいほどタイヤが鳴く */
  slip: number
  grounded: boolean
  /** ブーストの残り時間（秒） */
  boost: number
  /** 壁に当たっているか */
  scraping: boolean
  /** 今走っている路面（SURFACE_*） */
  surface: number
}

/**
 * 走っているあいだ鳴らし続ける音。
 * start() で鳴り始め、update() で変え続け、**必ず stop() で止める**。
 */
export class RaceEngineSound {
  private engine: Drone | null = null
  private engine2: Drone | null = null
  private sub: Drone | null = null
  private whine: Drone | null = null
  private wind: Drone | null = null
  private skid: Drone | null = null
  private phase = 0 // 排気の脈の位相
  private time = 0
  private gear = -1
  private shift = 0 // ギアが変わった直後の余韻（1 → 0）

  start(): void {
    if (this.engine) return
    // glide を小さくすると音量の変化に素早く追従するので、排気の脈を出せる
    this.engine = sound.drone({ type: 'sawtooth', filter: 1200, glide: 0.012 })
    this.engine2 = sound.drone({ type: 'sawtooth', filter: 900, glide: 0.012 })
    this.sub = sound.drone({ type: 'square', filter: 300, glide: 0.03 })
    this.whine = sound.drone({ type: 'triangle', filter: 6000, glide: 0.05 })
    this.wind = sound.noiseLoop()
    this.skid = sound.noiseLoop({ glide: 0.02 })
  }

  update(s: EngineState, dt: number): void {
    if (!this.engine || !this.engine2 || !this.sub || !this.whine || !this.wind || !this.skid) return
    this.time += dt
    const [rev, gear, within] = revs(s.speed, s.vmax)
    const load = clamp(s.throttle, 0, 1)
    const boosting = s.boost > 0
    const ratio = clamp(s.speed / Math.max(s.vmax, 1), 0, 1.3)
    const dirt = s.surface === SURFACE_DIRT

    // 空中ではタイヤに負荷がかからないので、エンジンだけ軽く吹け上がる
    const freq = ENGINE_BASE * rev * (s.grounded ? 1 : 1.22)

    // ギアが変わった瞬間だけ音量を落とす
    if (gear !== this.gear) {
      if (this.gear >= 0) this.shift = 1
      this.gear = gear
    }
    this.shift = Math.max(0, this.shift - dt * 7)

    // 排気の脈。回転が上がるほど速くなる
    this.phase += freq * 0.25 * dt * Math.PI * 2
    const burble = 0.76 + 0.24 * (0.5 + 0.5 * Math.sin(this.phase))
    // ゆっくりした揺らぎ（完全に一定だと機械音になる）
    const flutter = 1 + 0.008 * Math.sin(this.time * 31) + 0.005 * Math.sin(this.time * 17.3)
    // 最高段で回しきると途切れる（頭打ち感）
    const limiter = gear === GEARS - 1 && within > 0.92 && s.grounded
      ? (Math.sin(this.time * 95) > 0 ? 0.4 : 1) : 1

    const body = (0.028 + load * 0.05 + (boosting ? 0.028 : 0)) * burble * limiter * (1 - 0.55 * this.shift)
    this.engine.set(freq * flutter, body)
    this.engine2.set(freq * flutter * 1.006, body * 0.55) // わずかにずらして厚みを出す
    this.sub.set(freq * 0.5 * flutter, (0.022 + load * 0.028) * (1 - 0.5 * this.shift))
    // 高音の唸り。ブースト中と、回転が上がったときだけ聞こえる
    this.whine.set(freq * 6 * (boosting ? 1.2 : 1),
                   boosting ? 0.022 : within > 0.65 ? 0.007 * (within - 0.65) * 3 : 0)

    // 風と路面。空中では路面の音が消えて風だけになる（飛んでいる感じが出る）
    if (s.grounded) {
      this.wind.set((dirt ? 150 : 260) + s.speed * (dirt ? 30 : 46),
                    (dirt ? 0.03 : 0.010) + ratio * (dirt ? 0.075 : 0.045))
    } else {
      this.wind.set(700 + s.speed * 70, 0.028 + ratio * 0.075)
    }

    // タイヤ: 横滑りが大きいと鳴き、砂の上では常にざらつき、壁に擦ると大きく鳴る
    const squeal = s.grounded ? clamp((Math.abs(s.slip) - 4) / 14, 0, 1) : 0
    const loose = s.grounded && dirt ? 0.25 + ratio * 0.3 : 0
    const scrape = s.scraping ? 0.62 : 0
    this.skid.set(dirt ? 700 : 1500 + Math.abs(s.slip) * 90,
                  Math.max(squeal, loose, scrape) * 0.15)
  }

  stop(): void {
    for (const d of [this.engine, this.engine2, this.sub, this.whine, this.wind, this.skid]) d?.stop()
    this.engine = this.engine2 = this.sub = this.whine = this.wind = this.skid = null
  }
}

let lastHit = 0
let lastLand = 0

const chord = (notes: number[], opts: { dur?: number; gain?: number; type?: OscillatorType; gap?: number; from?: number }) => {
  const { dur = 0.2, gain = 0.07, type = 'square', gap = 0.06, from = 0 } = opts
  notes.forEach((n, i) => sound.tone({ freq: sound.note(n + from), dur, type, gain, delay: i * gap }))
}

/** 出来事のときに 1 回だけ鳴らす音 */
export const racerSounds = {
  /** カウントダウン。n は 3・2・1、0 ならスタート */
  count(n: number) {
    if (n > 0) {
      // 数字が減るほど高くなる（緊張感が上がる）
      const base = 3 + (3 - n) * 2
      sound.tone({ freq: sound.note(base), dur: 0.14, type: 'square', gain: 0.07 })
      sound.tone({ freq: sound.note(base + 12), dur: 0.1, type: 'triangle', gain: 0.03 })
    } else {
      sound.noise({ dur: 0.18, gain: 0.12, filter: 2600 })
      chord([15, 19, 22, 27], { dur: 0.42, gain: 0.075, type: 'square', gap: 0.025 })
      sound.tone({ freq: 70, to: 45, dur: 0.35, type: 'sine', gain: 0.16 })
    }
  },

  /** 着地。impact は落ちてきた速さ（m/s） */
  land(impact: number) {
    const now = performance.now()
    if (now - lastLand < 110) return
    lastLand = now
    const k = clamp(impact / 22, 0.25, 1)
    sound.noise({ dur: 0.1 + k * 0.12, gain: 0.1 + k * 0.24, filter: 240 + k * 460 })
    sound.tone({ freq: 118, to: 54, dur: 0.16, type: 'sine', gain: 0.1 + k * 0.16 })
    // タイヤが鳴く（強く落ちたときほど長く）
    sound.noise({ dur: 0.08 + k * 0.22, gain: 0.05 + k * 0.1, filter: 2400, delay: 0.03 })
    // 大きく落ちたときは車体がきしむ
    if (k > 0.7) sound.tone({ freq: 340, to: 210, dur: 0.14, type: 'square', gain: 0.045, delay: 0.04 })
  },

  /** 壁に当たった（擦り続けるあいだ鳴りすぎないように間引く） */
  hit() {
    const now = performance.now()
    if (now - lastHit < 200) return
    lastHit = now
    // 金属がぶつかる音: わずかにずれた音を重ねると濁って金属的に聞こえる
    sound.noise({ dur: 0.08, gain: 0.16, filter: 3600 })
    for (const [f, g] of [[430, 0.05], [617, 0.035], [911, 0.022]] as [number, number][]) {
      sound.tone({ freq: f, to: f * 0.82, dur: 0.12, type: 'square', gain: g })
    }
    sound.tone({ freq: 150, to: 95, dur: 0.1, type: 'sine', gain: 0.07 })
  },

  /** 加速パネルを踏んだ・トリックでブーストがついた */
  boost() {
    sound.tone({ freq: 180, to: 1300, dur: 0.32, type: 'sawtooth', gain: 0.07 })
    sound.noise({ dur: 0.42, gain: 0.13, filter: 1400 })
    sound.tone({ freq: 60, to: 40, dur: 0.25, type: 'sine', gain: 0.14 }) // 背中を押される低音
    chord([19, 26], { dur: 0.3, gain: 0.035, type: 'triangle', gap: 0.05 })
  },

  /** 空中で回って着地した。n は回った回数（多いほど派手に） */
  trick(n: number) {
    const steps = [0, 4, 7, 12, 16, 19, 24]
    const count = Math.min(3 + n * 2, steps.length)
    const base = 7 + Math.min(n, 3) * 2
    for (let i = 0; i < count; i++) {
      sound.tone({ freq: sound.note(base + steps[i]), dur: 0.15, type: 'triangle',
                   gain: 0.075, delay: i * 0.045 })
    }
    sound.noise({ dur: 0.2, gain: 0.06, filter: 4000 })
  },

  /** コースから落ちた */
  fall() {
    sound.tone({ freq: 480, to: 55, dur: 0.75, type: 'sawtooth', gain: 0.08 })
    sound.tone({ freq: 240, to: 40, dur: 0.8, type: 'square', gain: 0.03, delay: 0.02 })
    sound.noise({ dur: 0.6, gain: 0.07, filter: 450 })
  },

  /** 1 周まわった */
  lap() {
    chord([12, 19, 24], { dur: 0.16, gain: 0.065, type: 'square', gap: 0.07 })
  },

  /** ゴール。順位が 1 位なら華やかに、それ以外は控えめに */
  finish(won: boolean) {
    if (won) {
      chord([0, 4, 7, 12, 16, 19, 24], { dur: 0.26, gain: 0.08, type: 'square', gap: 0.09, from: 3 })
      chord([12, 19, 24], { dur: 0.7, gain: 0.05, type: 'triangle', gap: 0.0, from: 3 })
      sound.noise({ dur: 0.5, gain: 0.08, filter: 5000 })
    } else {
      chord([0, 4, 7, 12], { dur: 0.24, gain: 0.055, type: 'triangle', gap: 0.11, from: 3 })
    }
  },
}
