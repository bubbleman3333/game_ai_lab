// 灯守（タイピング）の音。音声ファイルは使わず、Web Audio でその場で作る（土台は lib/sound.ts）。
//
//   単発の音          打鍵・ミス・影を倒した・襲われた・ボスなど。出来事のときに 1 回鳴らす
//   鳴らしっぱなしの音 夜の森の風と低い唸り、虫の声。ForestAmbience で start() / update() / **stop()**

import { sound, type Drone } from '../../lib/sound'
import type { Sfx } from './sim/chapters'

/** 和風の音階（都節: レ・ミ♭・ソ・ラ・シ♭）。コンボが続くほど打鍵の音が上がっていく */
const MIYAKO = [0, 1, 5, 7, 8]

function scaleNote(step: number): number {
  const oct = Math.floor(step / MIYAKO.length)
  return sound.note(-7 + MIYAKO[step % MIYAKO.length] + oct * 12) // D4 から
}

/** ざらざらした音の元（打鍵の「カチッ」・斬撃の「シャッ」に使う）。一度作ったら使い回す */
let noiseBuf: AudioBuffer | null = null
function noiseOf(ctx: AudioContext): AudioBuffer {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

/**
 * フィルターを通したノイズを 1 回鳴らす（lib/sound.ts の noise() はローパスしか無いので、ここで組む）。
 * type: 'highpass' で「カチッ」、'bandpass' で「シャッ」。from → to でフィルターの周波数を動かせる
 */
function filteredNoise(type: BiquadFilterType, from: number, to: number, dur: number, gain: number, q = 1, delay = 0): void {
  const out = sound.output()
  if (!out || sound.settings.muted) return
  const { ctx } = out
  const t = ctx.currentTime + delay
  const src = ctx.createBufferSource()
  src.buffer = noiseOf(ctx)
  const f = ctx.createBiquadFilter()
  f.type = type
  f.Q.value = q
  f.frequency.setValueAtTime(from, t)
  f.frequency.exponentialRampToValueAtTime(to, t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.003)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(out.out)
  src.start(t)
  src.stop(t + dur + 0.02)
}

export const typingSounds = {
  /**
   * 打鍵: 3 つの音を重ねて「押した手応え」を出す。
   *   カチッ  高い帯域のごく短いノイズ（キーが底に当たる音）
   *   コトッ  中くらいの帯域のノイズ（キーの胴が鳴る音）
   *   ドン    すぐ下がる低い音（指に返ってくる重さ）
   * その上に、コンボで音階が上がる短い音を小さくのせる（10 コンボごとに、きらっと高い音）。
   */
  key(combo: number) {
    const step = Math.min(14, Math.floor(combo / 3))
    const f = scaleNote(step) * 2
    filteredNoise('highpass', 6500, 4200, 0.02, 0.32, 0.8)
    filteredNoise('bandpass', 1500, 700, 0.055, 0.34, 1.6)
    sound.tone({ freq: 210, to: 65, dur: 0.075, type: 'sine', gain: 0.24 })
    sound.tone({ freq: f, dur: 0.09, type: 'sine', gain: 0.045 })
    if (combo > 0 && combo % 10 === 0) {
      sound.tone({ freq: f * 3, dur: 0.25, type: 'sine', gain: 0.05, delay: 0.03 })
      sound.tone({ freq: f * 4, dur: 0.3, type: 'sine', gain: 0.04, delay: 0.07 })
    }
  },
  /** まちがい: 鈍い「ゴッ」と、こもった短いノイズ */
  miss() {
    sound.tone({ freq: 95, to: 55, dur: 0.12, type: 'square', gain: 0.05 })
    filteredNoise('lowpass', 900, 300, 0.08, 0.12)
  },
  /** 狙いを定めた: 刀を構えたような、短く上がる「シュッ」 */
  lock() {
    filteredNoise('bandpass', 1800, 6000, 0.09, 0.08, 2)
  },
  /** 倒した: 斬撃の「シャッ」→ 低い「ドン」→ 光に還る鐘の和音 */
  kill(boss: boolean) {
    filteredNoise('bandpass', 7000, 900, boss ? 0.35 : 0.18, boss ? 0.3 : 0.22, 1.5)
    sound.tone({ freq: 110, to: 40, dur: boss ? 0.6 : 0.25, type: 'sine', gain: boss ? 0.25 : 0.14 })
    const notes = boss ? [0, 7, 12, 15, 19, 24, 27] : [0, 7, 12, 15]
    notes.forEach((n, i) => {
      const f = sound.note(5 + n)
      const delay = 0.04 + i * (boss ? 0.08 : 0.035)
      sound.tone({ freq: f, dur: boss ? 1.4 : 0.6, type: 'sine', gain: 0.07, delay })
      // 鐘らしさ: 少しずれた高い倍音を重ねる
      sound.tone({ freq: f * 2.76, dur: boss ? 0.8 : 0.3, type: 'sine', gain: 0.02, delay })
    })
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
  /** 忘れ神の鈴: 澄んだ高い音が、長く響く */
  bell() {
    ;[0, 7, 12, 19].forEach((n, i) => sound.tone({ freq: sound.note(15 + n), dur: 2.2 - i * 0.3, type: 'sine', gain: 0.1 - i * 0.015, delay: i * 0.02 }))
    sound.tone({ freq: sound.note(15) * 2.76, dur: 1.2, type: 'sine', gain: 0.04 })
  },
  /** 森を歩く足音（1 歩ぶん。落ち葉を踏む） */
  step() {
    filteredNoise('lowpass', 700, 220, 0.08, 0.07)
    filteredNoise('highpass', 3200, 2400, 0.04, 0.025, 1, 0.015)
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


/** 物語の効果音。台詞が出た瞬間に 1 回鳴らす */
export const storySfx: Record<Sfx, () => void> = {
  /** ひぐらし（夕暮れの「カナカナカナ…」） */
  higurashi() {
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 9; i++) {
        const f = 4300 - i * 70
        sound.tone({ freq: f, to: f * 0.92, dur: 0.06, type: 'triangle', gain: 0.03 * (1 - i / 11), delay: r * 1.3 + i * 0.085 })
      }
    }
  },
  /** 障子を勢いよく開ける */
  door() {
    filteredNoise('bandpass', 500, 1100, 0.35, 0.22, 1.2)
    sound.tone({ freq: 120, to: 70, dur: 0.12, type: 'sine', gain: 0.18, delay: 0.33 })
  },
  /** 心臓の音（どくん、どくん） */
  heartbeat() {
    for (const base of [0, 0.85]) {
      sound.tone({ freq: 62, to: 38, dur: 0.14, type: 'sine', gain: 0.32, delay: base })
      sound.tone({ freq: 55, to: 36, dur: 0.12, type: 'sine', gain: 0.22, delay: base + 0.22 })
    }
  },
  /** 強い風がざあっと吹き抜ける */
  gust() {
    filteredNoise('bandpass', 300, 1400, 1.6, 0.2, 0.8)
  },
  /** 落ち葉を踏んで歩く */
  footsteps() {
    for (let i = 0; i < 4; i++) {
      filteredNoise('lowpass', 900, 250, 0.09, 0.16, 1, i * 0.45)
      filteredNoise('highpass', 3500, 2500, 0.05, 0.05, 1, i * 0.45 + 0.02)
    }
  },
  /** フクロウ（ほう、ほーう） */
  owl() {
    sound.tone({ freq: 430, to: 390, dur: 0.22, type: 'sine', gain: 0.1 })
    sound.tone({ freq: 450, to: 360, dur: 0.55, type: 'sine', gain: 0.1, delay: 0.42 })
  },
  /** ランタンに火を灯す（ぼっ、ぱちぱち） */
  ignite() {
    filteredNoise('bandpass', 300, 2800, 0.35, 0.22, 1)
    sound.tone({ freq: 180, to: 520, dur: 0.3, type: 'sine', gain: 0.06 })
    for (let i = 0; i < 5; i++) filteredNoise('highpass', 4000, 3000, 0.02, 0.08, 1, 0.3 + Math.random() * 0.6)
  },
  /** 影のささやき（何を言っているか聞き取れない声） */
  whisper() {
    for (let i = 0; i < 6; i++) {
      const f = 1400 + Math.random() * 2000
      filteredNoise('bandpass', f, f * (0.8 + Math.random() * 0.4), 0.18, 0.07, 7, i * 0.16 + Math.random() * 0.05)
    }
  },
  /** 地鳴り（大きな影の声・気配） */
  rumble() {
    sound.tone({ freq: 48, to: 34, dur: 2, type: 'sawtooth', gain: 0.12 })
    sound.tone({ freq: 51, to: 36, dur: 2, type: 'sawtooth', gain: 0.08 })
    filteredNoise('lowpass', 260, 90, 1.8, 0.2)
  },
  /** 水音（ぴちゃん） */
  splash() {
    sound.tone({ freq: 1300, to: 520, dur: 0.09, type: 'sine', gain: 0.08 })
    filteredNoise('lowpass', 1800, 400, 0.25, 0.08, 1, 0.03)
    sound.tone({ freq: 1500, to: 700, dur: 0.07, type: 'sine', gain: 0.04, delay: 0.5 })
  },
  bell() {
    typingSounds.bell()
  },
  /** 羽ばたき */
  flutter() {
    for (let i = 0; i < 5; i++) filteredNoise('bandpass', 900, 500, 0.08, 0.14, 1.5, i * 0.11)
  },
}
