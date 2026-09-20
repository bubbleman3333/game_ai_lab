// 効果音の土台。音声ファイルは使わず、Web Audio でその場で音を作る（権利を気にせず公開できる）。
// ゲームごとの音の中身は games/<ゲーム>/sounds.ts に書く。
// 使い方: sound.tone({ freq: 440, dur: 0.1 })  /  sound.noise({ dur: 0.05 })

export interface ToneOptions {
  freq: number
  /** 終わりの周波数（指定すると音程が滑らかに変わる） */
  to?: number
  /** 長さ（秒） */
  dur: number
  type?: OscillatorType
  /** 音量（0〜1。全体の音量が掛かる） */
  gain?: number
  /** 何秒後に鳴らすか */
  delay?: number
}

export interface NoiseOptions {
  dur: number
  gain?: number
  /** ローパスフィルターの周波数（低いほどこもった音） */
  filter?: number
  delay?: number
}

/**
 * 鳴らしっぱなしにする音（車のエンジン音など）。
 * `tone` / `noise` は「一度鳴って消える音」だが、こちらは stop() を呼ぶまで鳴り続け、
 * そのあいだ音程と音量を変え続けられる。**使い終わったら必ず stop() を呼ぶこと**。
 */
export interface Drone {
  /**
   * 音程と音量を変える。毎フレーム呼んでよい（急に変えてもプチッと鳴らないようにしてある）。
   * noiseLoop の場合、pitch はこもり具合（ローパスフィルターの周波数）になる。
   */
  set(pitch: number, gain: number): void
  stop(): void
}

export interface SoundSettings {
  volume: number // 0〜1
  muted: boolean
}

const STORAGE_KEY = 'game-ai-lab:sound'
const DEFAULT_SETTINGS: SoundSettings = { volume: 0.6, muted: false }

/** 音が出せないとき（ブラウザがまだ音を許していないなど）に返す、何もしない Drone */
const SILENT: Drone = { set() {}, stop() {} }

/** drone / noiseLoop の共通部分。音量の変え方と止め方はどちらも同じ */
function makeDrone(ctx: AudioContext, g: GainNode,
                   setPitch: (t: number, pitch: number) => void,
                   stopSource: (t: number) => void, glide = 0.04): Drone {
  let stopped = false
  return {
    set(pitch, gain) {
      if (stopped) return
      const t = ctx.currentTime
      setPitch(t, pitch)
      // setTargetAtTime: 目標値へじわっと近づける。毎フレーム呼んでもプチッと鳴らない
      g.gain.setTargetAtTime(Math.max(gain, 0), t, glide)
    },
    stop() {
      if (stopped) return
      stopped = true
      const t = ctx.currentTime
      g.gain.setTargetAtTime(0, t, 0.05)
      stopSource(t + 0.4) // 音量が下がりきってから止める
    },
  }
}

function loadSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private listeners = new Set<() => void>()
  settings: SoundSettings = loadSettings()

  constructor() {
    // ブラウザは「ユーザーが操作するまで音を出さない」ので、最初のクリック・キー入力で準備する
    if (typeof window !== 'undefined') {
      const unlock = () => this.ensure()
      window.addEventListener('pointerdown', unlock, { once: true })
      window.addEventListener('keydown', unlock, { once: true })
    }
  }

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return null
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      this.applyVolume()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private applyVolume(): void {
    if (this.master) this.master.gain.value = this.settings.muted ? 0 : this.settings.volume
  }

  // --- 設定 ---------------------------------------------------------------
  update(patch: Partial<SoundSettings>): void {
    this.settings = { ...this.settings, ...patch }
    this.applyVolume()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings))
    } catch {
      /* 保存できなくても音は鳴らす */
    }
    for (const l of this.listeners) l()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private get active(): boolean {
    return !this.settings.muted && this.settings.volume > 0
  }

  // --- 音を鳴らす ------------------------------------------------------------
  tone({ freq, to, dur, type = 'sine', gain = 0.2, delay = 0 }: ToneOptions): void {
    if (!this.active) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur)
    // プチッという音が出ないよう、立ち上がりと消え際をなめらかにする
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  /** ざらざらした音の元（0.5 秒ぶんの乱数）。一度作ったら使い回す */
  private buffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate)
      const d = this.noiseBuffer.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    }
    return this.noiseBuffer
  }

  noise({ dur, gain = 0.2, filter = 2000, delay = 0 }: NoiseOptions): void {
    if (!this.active) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = this.buffer(ctx)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = filter
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(lp).connect(g).connect(this.master)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  // --- 鳴らしっぱなしの音 ------------------------------------------------------
  // 音を止めるのは stop() のときだけで、ミュートや音量は master につながっているので自動で効く。

  /**
   * 鳴らしっぱなしの音（エンジン音など）。set(周波数, 音量) で変え続ける。
   *
   * glide は set() したときに新しい値へ移るまでの時間（秒）。小さくすると素早く追従するので、
   * 毎フレーム音量を揺らして「ボボボ」という脈を作れる。大きいとなめらかだが揺らせない。
   */
  drone({ type = 'sawtooth', filter = 1400, glide = 0.04 }:
        { type?: OscillatorType; filter?: number; glide?: number } = {}): Drone {
    const ctx = this.ensure()
    if (!ctx || !this.master) return SILENT
    const osc = ctx.createOscillator()
    osc.type = type
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = filter
    const g = ctx.createGain()
    g.gain.value = 0
    osc.connect(lp).connect(g).connect(this.master)
    osc.start()
    return makeDrone(ctx, g, (t, pitch) => osc.frequency.setTargetAtTime(Math.max(pitch, 20), t, 0.02),
                     (t) => osc.stop(t), glide)
  }

  /** 鳴らしっぱなしのノイズ（風・タイヤの滑る音など）。set(こもり具合, 音量) で変え続ける */
  noiseLoop({ glide = 0.04 }: { glide?: number } = {}): Drone {
    const ctx = this.ensure()
    if (!ctx || !this.master) return SILENT
    const src = ctx.createBufferSource()
    src.buffer = this.buffer(ctx)
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1000
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(lp).connect(g).connect(this.master)
    src.start()
    return makeDrone(ctx, g, (t, pitch) => lp.frequency.setTargetAtTime(Math.max(pitch, 60), t, 0.05),
                     (t) => src.stop(t), glide)
  }

  /** 音階の周波数（A4 = 440Hz から半音 n 個上） */
  note(semitonesFromA4: number): number {
    return 440 * 2 ** (semitonesFromA4 / 12)
  }
}

export const sound = new SoundEngine()
