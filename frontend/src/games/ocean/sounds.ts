// 海の音。音声ファイルは使わず、Web Audio でその場で作る（土台は lib/sound.ts）。
//
// 2 種類ある:
//   鳴らしっぱなしの音  波の音・水中のこもった低い音。毎フレーム update() で変え続ける
//   単発の音            刺された・噛まれた・サメの警告・真珠など。出来事のときに 1 回鳴らす

import { sound, type Drone } from '../../lib/sound'

export interface AmbienceState {
  /** 潜っているか（頭が水の中） */
  underwater: boolean
  /** 深さ（0〜1。潜れる深さに対する割合） */
  depth: number
  /** 泳ぐ速さ（0〜1。ダッシュで 1） */
  effort: number
  /** 体力が少ない・息が切れそう（心臓の音を鳴らす） */
  danger: boolean
  /** サメが近くにいる（低い唸りを足す） */
  menace: number
}

/**
 * 泳いでいるあいだ鳴らし続ける音。
 * start() で鳴り始め、update() で変え続け、**必ず stop() で止める**。
 */
export class OceanAmbience {
  private waves: Drone | null = null
  private rumble: Drone | null = null
  private menace: Drone | null = null
  private time = 0
  private heartTimer = 0
  private strokeTimer = 0

  start(): void {
    if (this.waves) return
    this.waves = sound.noiseLoop({ glide: 0.2 })
    this.rumble = sound.drone({ type: 'sine', filter: 200, glide: 0.2 })
    this.menace = sound.drone({ type: 'sawtooth', filter: 260, glide: 0.15 })
  }

  update(s: AmbienceState, dt: number): void {
    if (!this.waves || !this.rumble || !this.menace) return
    this.time += dt
    // 波: 海面ではざわざわ、水中ではこもって静かになる
    const swell = 0.5 + 0.5 * Math.sin(this.time * 0.9) * Math.sin(this.time * 0.37)
    if (s.underwater) {
      this.waves.set(180 + 60 * swell, 0.02 + 0.02 * s.effort)
      this.rumble.set(46 + 6 * Math.sin(this.time * 0.6), 0.05 + 0.05 * s.depth)
    } else {
      this.waves.set(500 + 420 * swell + 300 * s.effort, 0.035 + 0.03 * swell + 0.03 * s.effort)
      this.rumble.set(40, 0.0)
    }
    // サメが近いと、低い唸り（映画の「ダダン」の下敷きになる音）
    this.menace.set(41 + 2 * Math.sin(this.time * 5), s.menace * 0.05)

    // 心臓の音（体力が少ない・息が切れそうなとき）
    if (s.danger) {
      this.heartTimer -= dt
      if (this.heartTimer <= 0) {
        this.heartTimer = 0.8
        sound.tone({ freq: 62, to: 40, dur: 0.11, type: 'sine', gain: 0.22 })
        sound.tone({ freq: 56, to: 38, dur: 0.1, type: 'sine', gain: 0.16, delay: 0.16 })
      }
    }
    // 手のかき（海面で泳いでいるときの、ぱしゃぱしゃという音）
    if (!s.underwater) {
      this.strokeTimer -= dt
      if (this.strokeTimer <= 0) {
        this.strokeTimer = s.effort > 0.5 ? 0.42 : 0.62
        sound.noise({ dur: 0.12, gain: 0.05 + 0.04 * s.effort, filter: 2600 })
      }
    }
  }

  stop(): void {
    for (const d of [this.waves, this.rumble, this.menace]) d?.stop()
    this.waves = this.rumble = this.menace = null
  }
}

const chord = (notes: number[], opts: { dur?: number; gain?: number; type?: OscillatorType; gap?: number; from?: number }) => {
  const { dur = 0.2, gain = 0.07, type = 'square', gap = 0.06, from = 0 } = opts
  notes.forEach((n, i) => sound.tone({ freq: sound.note(n + from), dur, type, gain, delay: i * gap }))
}

/** 出来事のときに 1 回だけ鳴らす音 */
export const oceanSounds = {
  /** クラゲに刺された（ビリッ） */
  sting() {
    sound.tone({ freq: 1400, to: 300, dur: 0.16, type: 'sawtooth', gain: 0.07 })
    sound.tone({ freq: 900, to: 200, dur: 0.22, type: 'square', gain: 0.05, delay: 0.02 })
    sound.noise({ dur: 0.12, gain: 0.08, filter: 5000 })
    // ビリビリの余韻
    for (let i = 0; i < 5; i++) {
      sound.tone({ freq: 700 + Math.random() * 600, dur: 0.04, type: 'square', gain: 0.03, delay: 0.1 + i * 0.05 })
    }
  },

  /** サメに噛まれた（ガブッ） */
  bite() {
    sound.noise({ dur: 0.22, gain: 0.3, filter: 900 })
    sound.tone({ freq: 140, to: 38, dur: 0.4, type: 'sawtooth', gain: 0.16 })
    sound.tone({ freq: 90, to: 30, dur: 0.5, type: 'sine', gain: 0.24 })
    // 歯が当たる、硬い音
    for (const [f, d] of [[1800, 0], [1300, 0.03], [2400, 0.05]] as [number, number][]) {
      sound.tone({ freq: f, to: f * 0.5, dur: 0.05, type: 'square', gain: 0.05, delay: d })
    }
  },

  /** サメが現れた（映画のあの「ダ・ダン」） */
  warn() {
    for (let i = 0; i < 2; i++) {
      const d = i * 0.55
      sound.tone({ freq: sound.note(-33), dur: 0.22, type: 'sawtooth', gain: 0.12, delay: d })
      sound.tone({ freq: sound.note(-32), dur: 0.3, type: 'sawtooth', gain: 0.13, delay: d + 0.24 })
      sound.tone({ freq: sound.note(-45), dur: 0.3, type: 'sine', gain: 0.2, delay: d + 0.24 })
    }
  },

  /** サメが突っ込んできた（水を切る音） */
  charge() {
    sound.noise({ dur: 0.7, gain: 0.14, filter: 1600 })
    sound.tone({ freq: 60, to: 180, dur: 0.6, type: 'sawtooth', gain: 0.06 })
  },

  /** サメをかわした（ヒュッ） */
  dodge() {
    sound.noise({ dur: 0.35, gain: 0.12, filter: 3200 })
    chord([12, 16, 19], { dur: 0.14, gain: 0.05, type: 'triangle', gap: 0.05, from: 5 })
  },

  /** サメの鼻先を蹴った（ドスッ） */
  punch() {
    sound.noise({ dur: 0.14, gain: 0.22, filter: 600 })
    sound.tone({ freq: 160, to: 50, dur: 0.22, type: 'square', gain: 0.1 })
    chord([7, 12, 19, 24], { dur: 0.2, gain: 0.06, type: 'square', gap: 0.05, from: 3 })
  },

  /** 空振りの蹴り */
  kick() {
    sound.noise({ dur: 0.12, gain: 0.07, filter: 2200 })
  },

  /** 真珠を拾った */
  pearl() {
    chord([19, 26, 31], { dur: 0.18, gain: 0.05, type: 'triangle', gap: 0.04, from: 3 })
  },

  /** 新しい区間に入った */
  zone() {
    chord([0, 7, 12, 16, 19, 24], { dur: 0.3, gain: 0.05, type: 'triangle', gap: 0.08, from: 0 })
  },

  /** 潜った（ボチャン） */
  submerge() {
    sound.noise({ dur: 0.25, gain: 0.14, filter: 700 })
    sound.tone({ freq: 400, to: 90, dur: 0.25, type: 'sine', gain: 0.08 })
  },

  /** 海面に出た（プハッ） */
  surface() {
    sound.noise({ dur: 0.2, gain: 0.12, filter: 3000 })
    sound.tone({ freq: 200, to: 500, dur: 0.15, type: 'sine', gain: 0.05 })
  },

  /** 息が切れて体力が減った */
  drowning() {
    sound.tone({ freq: 220, to: 120, dur: 0.35, type: 'triangle', gain: 0.08 })
    sound.noise({ dur: 0.3, gain: 0.06, filter: 400 })
  },

  /** 力尽きた */
  dead() {
    for (let i = 0; i < 5; i++) {
      sound.tone({ freq: sound.note(-5 - i * 3), dur: 0.35, type: 'triangle', gain: 0.07, delay: i * 0.22 })
    }
    sound.tone({ freq: 90, to: 30, dur: 1.6, type: 'sine', gain: 0.14 })
  },
}
