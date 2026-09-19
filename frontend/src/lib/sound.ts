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

export interface SoundSettings {
  volume: number // 0〜1
  muted: boolean
}

const STORAGE_KEY = 'game-ai-lab:sound'
const DEFAULT_SETTINGS: SoundSettings = { volume: 0.6, muted: false }

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

  noise({ dur, gain = 0.2, filter = 2000, delay = 0 }: NoiseOptions): void {
    if (!this.active) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate)
      const d = this.noiseBuffer.getChannelData(0)
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    }
    const t = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
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

  /** 音階の周波数（A4 = 440Hz から半音 n 個上） */
  note(semitonesFromA4: number): number {
    return 440 * 2 ** (semitonesFromA4 / 12)
  }
}

export const sound = new SoundEngine()
