// 灯守（タイピング）の音。音声ファイルは使わず、Web Audio でその場で作る（土台は lib/sound.ts）。
//
//   単発の音          打鍵・ミス・影を倒した・襲われた・ボスなど。出来事のときに 1 回鳴らす
//   鳴らしっぱなしの音 夜の森の風と低い唸り、虫の声。ForestAmbience で start() / update() / **stop()**

import { sound, type Drone } from '../../lib/sound'

/** ペンタトニック（ド・レ・ミ・ソ・ラ）。コンボが続くほど打鍵の音が上がっていく */
const PENTA = [0, 2, 4, 7, 9]

function pentaNote(step: number): number {
  const oct = Math.floor(step / PENTA.length)
  return sound.note(-9 + PENTA[step % PENTA.length] + oct * 12) // C4 から
}

export const typingSounds = {
  key(combo: number) {
    const step = Math.min(14, Math.floor(combo / 4))
    sound.tone({ freq: pentaNote(step) * 2, dur: 0.06, type: 'triangle', gain: 0.07 })
  },
  miss() {
    sound.tone({ freq: 110, to: 90, dur: 0.12, type: 'square', gain: 0.06 })
  },
  lock() {
    sound.tone({ freq: 880, dur: 0.04, type: 'sine', gain: 0.04 })
  },
  kill(boss: boolean) {
    // 光に戻る: きらきらした上りの分散和音
    const notes = boss ? [0, 4, 7, 12, 16, 19, 24] : [0, 4, 7, 12]
    notes.forEach((n, i) => sound.tone({ freq: sound.note(3 + n), dur: boss ? 0.9 : 0.35, type: 'sine', gain: 0.09, delay: i * (boss ? 0.09 : 0.05) }))
    sound.noise({ dur: 0.25, gain: 0.04, filter: 6000 })
  },
  hit(damage: number) {
    sound.tone({ freq: 140, to: 50, dur: 0.4, type: 'sawtooth', gain: 0.16 })
    sound.noise({ dur: 0.35, gain: 0.18 * damage, filter: 700 })
  },
  heal() {
    ;[0, 7, 12].forEach((n, i) => sound.tone({ freq: sound.note(8 + n), dur: 0.3, type: 'triangle', gain: 0.07, delay: i * 0.07 }))
  },
  wave() {
    sound.tone({ freq: sound.note(-12), dur: 1.2, type: 'sine', gain: 0.12 })
    sound.tone({ freq: sound.note(-5), dur: 1.2, type: 'sine', gain: 0.06, delay: 0.15 })
  },
  boss() {
    sound.tone({ freq: 55, to: 45, dur: 2.2, type: 'sawtooth', gain: 0.14 })
    sound.tone({ freq: 58, to: 47, dur: 2.2, type: 'sawtooth', gain: 0.1 })
    sound.noise({ dur: 1.8, gain: 0.1, filter: 300 })
  },
  bossHurt() {
    sound.tone({ freq: sound.note(-2), to: sound.note(-14), dur: 0.5, type: 'triangle', gain: 0.12 })
    ;[0, 5, 12].forEach((n, i) => sound.tone({ freq: sound.note(10 + n), dur: 0.4, type: 'sine', gain: 0.07, delay: 0.1 + i * 0.06 }))
  },
  clear() {
    ;[0, 4, 7, 12, 7, 12, 16].forEach((n, i) => sound.tone({ freq: sound.note(3 + n), dur: 0.5, type: 'triangle', gain: 0.09, delay: i * 0.12 }))
  },
  dead() {
    ;[0, -3, -7, -12].forEach((n, i) => sound.tone({ freq: sound.note(-5 + n), dur: 0.7, type: 'sine', gain: 0.1, delay: i * 0.25 }))
  },
  /** 物語の文字送り */
  page() {
    sound.tone({ freq: 660, dur: 0.05, type: 'sine', gain: 0.04 })
  },
}

/**
 * 夜の森でずっと鳴らす音。start() で鳴り始め、update() で変え続け、**必ず stop() で止める**。
 */
export class ForestAmbience {
  private wind: Drone | null = null
  private hum: Drone | null = null
  private time = 0
  private cricketTimer = 1

  start(): void {
    if (this.wind) return
    this.wind = sound.noiseLoop({ glide: 0.4 })
    this.hum = sound.drone({ type: 'sine', filter: 300, glide: 0.3 })
  }

  /** danger: 0〜1（影が近い・ボス戦で大きく） */
  update(dt: number, danger: number): void {
    this.time += dt
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.13)
    this.wind?.set(300 + gust * 500, 0.03 + gust * 0.04)
    this.hum?.set(55 + danger * 10, 0.02 + danger * 0.08)
    // 虫の声（影が近いと鳴きやむ）
    this.cricketTimer -= dt
    if (this.cricketTimer <= 0) {
      this.cricketTimer = 0.9 + Math.random() * 2.2
      if (danger < 0.5) {
        const f = 4200 + Math.random() * 600
        for (let i = 0; i < 3; i++) sound.tone({ freq: f, dur: 0.03, type: 'sine', gain: 0.015, delay: i * 0.06 })
      }
    }
  }

  stop(): void {
    this.wind?.stop()
    this.hum?.stop()
    this.wind = this.hum = null
  }
}
