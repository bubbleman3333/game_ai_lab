// レースの音。音声ファイルは使わず、Web Audio でその場で作る（土台は lib/sound.ts）。
//
// 2 種類ある:
//   鳴らしっぱなしの音  エンジン・風切り音・タイヤの滑る音。毎フレーム update() で変え続ける
//   単発の音            カウントダウン・周回・着地・トリックなど。出来事が起きたときに 1 回鳴らす
//
// エンジン音は「速度が上がると音程が上がり、ある速度でガクンと下がってまた上がる」ようにしてある
// （ギアが切り替わる感じ）。速度に比例させるだけだと、ずっと同じ音がだらだら上がるだけで速く感じない。

import { sound, type Drone } from '../../lib/sound'

const GEARS = 5 // いくつギアがあるか（音程が下がって上がり直す回数）
const IDLE = 0.55 // ギアに入った直後の音程の低さ（1 で切り替え直前と同じ）
const ENGINE_BASE = 92 // 1 速に入った直後のエンジンの周波数（Hz）

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** 速度から「エンジンの回り具合」（0.55〜1.35 くらい）を出す */
function revs(speed: number, vmax: number): number {
  const t = clamp(speed / Math.max(vmax, 1), 0, 1.35)
  const gear = Math.min(Math.floor(t * GEARS), GEARS - 1)
  const within = t * GEARS - gear // そのギアの中でどこまで回したか
  return IDLE + within * (1 - IDLE) * 1.6
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
}

/**
 * 走っているあいだ鳴らし続ける音。
 * start() で鳴り始め、update() で変え続け、**必ず stop() で止める**。
 */
export class RaceEngineSound {
  private engine: Drone | null = null
  private sub: Drone | null = null
  private wind: Drone | null = null
  private skid: Drone | null = null

  start(): void {
    if (this.engine) return
    this.engine = sound.drone({ type: 'sawtooth', filter: 1100 })
    this.sub = sound.drone({ type: 'square', filter: 320 }) // 1 オクターブ下。太さを足す
    this.wind = sound.noiseLoop() // 路面と風の音
    this.skid = sound.noiseLoop() // タイヤの滑る音
  }

  update(s: EngineState): void {
    if (!this.engine || !this.sub || !this.wind || !this.skid) return
    const load = clamp(s.throttle, 0, 1)
    const ratio = clamp(s.speed / Math.max(s.vmax, 1), 0, 1.3)
    // 空中ではタイヤに負荷がかからないので、エンジンだけ軽く吹け上がる
    const freq = ENGINE_BASE * revs(s.speed, s.vmax) * (s.grounded ? 1 : 1.22)
    const boosting = s.boost > 0
    this.engine.set(freq, 0.03 + load * 0.045 + (boosting ? 0.025 : 0))
    this.sub.set(freq / 2, 0.025 + load * 0.03)

    // 風と路面: 速いほど大きく、こもりが取れて高くなる
    this.wind.set(260 + s.speed * 46, s.grounded ? 0.012 + ratio * 0.05 : 0.02 + ratio * 0.07)

    // タイヤ: 横滑りが大きいときだけ鳴く。壁に擦っているときも鳴らす
    const squeal = s.grounded ? clamp((Math.abs(s.slip) - 4) / 14, 0, 1) : 0
    const scrape = s.scraping ? 0.5 : 0
    this.skid.set(1500 + Math.abs(s.slip) * 90, Math.max(squeal, scrape) * 0.14)
  }

  stop(): void {
    for (const d of [this.engine, this.sub, this.wind, this.skid]) d?.stop()
    this.engine = this.sub = this.wind = this.skid = null
  }
}

let lastHit = 0
let lastLand = 0

/** 出来事のときに 1 回だけ鳴らす音 */
export const racerSounds = {
  /** カウントダウン。n は 3・2・1、0 ならスタート */
  count(n: number) {
    if (n > 0) sound.tone({ freq: sound.note(3), dur: 0.12, type: 'square', gain: 0.06 })
    else {
      sound.tone({ freq: sound.note(15), dur: 0.3, type: 'square', gain: 0.08 })
      sound.tone({ freq: sound.note(22), dur: 0.3, type: 'triangle', gain: 0.05, delay: 0.02 })
    }
  },
  /** 着地。impact は落ちてきた速さ（m/s） */
  land(impact: number) {
    const now = performance.now()
    if (now - lastLand < 120) return
    lastLand = now
    const k = clamp(impact / 22, 0.25, 1)
    sound.noise({ dur: 0.1 + k * 0.1, gain: 0.1 + k * 0.22, filter: 260 + k * 420 })
    sound.tone({ freq: 120, to: 62, dur: 0.14, type: 'sine', gain: 0.1 + k * 0.14 })
  },
  /** 壁に当たった（擦り続けるあいだ鳴りすぎないように間引く） */
  hit() {
    const now = performance.now()
    if (now - lastHit < 220) return
    lastHit = now
    sound.noise({ dur: 0.07, gain: 0.16, filter: 3200 })
    sound.tone({ freq: 210, to: 150, dur: 0.07, type: 'square', gain: 0.05 })
  },
  /** 加速パネルを踏んだ・トリックでブーストがついた */
  boost() {
    sound.noise({ dur: 0.3, gain: 0.12, filter: 900 })
    sound.tone({ freq: 220, to: 900, dur: 0.28, type: 'sawtooth', gain: 0.06 })
  },
  /** 空中で回って着地した。n は回った回数（多いほど高く長く鳴る） */
  trick(n: number) {
    const base = 7 + Math.min(n, 4) * 3
    ;[0, 4, 7, 12].forEach((s, i) =>
      sound.tone({ freq: sound.note(base + s), dur: 0.16, type: 'triangle', gain: 0.07, delay: i * 0.05 }))
  },
  /** コースから落ちた */
  fall() {
    sound.tone({ freq: 420, to: 70, dur: 0.6, type: 'sawtooth', gain: 0.07 })
    sound.noise({ dur: 0.5, gain: 0.07, filter: 500 })
  },
  /** 1 周まわった */
  lap() {
    ;[0, 7].forEach((s, i) =>
      sound.tone({ freq: sound.note(s + 12), dur: 0.14, type: 'square', gain: 0.06, delay: i * 0.09 }))
  },
  /** ゴール。順位が 1 位なら華やかに、それ以外は控えめに */
  finish(won: boolean) {
    const notes = won ? [0, 4, 7, 12, 16, 19] : [0, 4, 7, 12]
    notes.forEach((s, i) =>
      sound.tone({ freq: sound.note(s + 3), dur: 0.22, type: won ? 'square' : 'triangle',
                   gain: won ? 0.08 : 0.06, delay: i * 0.1 }))
  },
}
