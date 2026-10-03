// 戦いの BGM。音声ファイルは使わず、Web Audio でその場で鳴らす（土台は lib/sound.ts の output()）。
//
// 曲の作り方（和風に聞こえ、音がぶつからないように）:
//   - 音階は D の都節（レ・ミ♭・ソ・ラ・シ♭）だけを使う。西洋の和音進行は使わず、
//     下で「レとラ」（ときどき「ソとレ」）を伸ばし続ける（持続低音）。その上で琴と尺八が旋律を奏でる
//   - 琴・三味線は、弦をはじく物理モデル（カープラス・ストロング法）で、弦の振動を計算して作る。
//     はじいた瞬間のざらつきと、だんだん丸くなる減衰が本物の弦に近い
//   - 尺八は、息のノイズを細い共鳴（バンドパス）に通した音と、揺れる正弦波を重ねる
//   - 太鼓は、音程が急に下がる低い音と、皮をたたくざらつき
//
// 2 つの曲:
//   field  道中。テンポ 76、16 小節。静かな琴の音型と心臓のような太鼓。影が近いほど（intensity）琴が細かくなり、締太鼓が加わる
//   boss   ボス戦。テンポ 138、16 小節。登場の瞬間に太鼓の連打と銅鑼（toBoss）。
//          1〜4 小節 導入（太鼓と琴の刻み）→ 5〜12 小節 尺八の旋律 → 13〜16 小節 最高潮（篠笛が 1 オクターブ上で）
//
// しくみ: 25 ミリ秒ごとに「少し先（0.15 秒）までに鳴らす音」を予約する（音のタイミングがずれないため）。
// **使い終わったら必ず stop() を呼ぶこと**（呼ばないと鳴り続ける）。

import { sound } from '../../lib/sound'

const LOOKAHEAD = 0.15
/** D4 から半音 n 個上の周波数（D4 = 293.66Hz） */
const d = (n: number) => 293.66 * 2 ** (n / 12)

/** 都節の音（D4 からの半音）。2 オクターブ半ぶん */
const MIYAKO = [-12, -11, -7, -5, -4, 0, 1, 5, 7, 8, 12, 13, 17, 19, 20, 24]

/** 道中の琴の音型（MIYAKO の番号。null は休み）。8 分音符 8 つ = 1 小節 */
const FIELD_PATTERNS: (number | null)[][] = [
  [5, null, 7, 8, 7, null, 5, null],
  [5, 7, 9, null, 8, 7, null, null],
  [3, 5, 7, null, 6, 5, 3, null],
  [8, null, 7, 5, 6, null, 5, null],
  [10, null, 9, 8, 7, null, 8, 7],
  [5, null, null, 7, 8, null, 10, null],
]

/** 道中の尺八（D4 からの半音、長さは 8 分いくつぶんか）。4 小節 = 8 分 32 個 */
const FIELD_FLUTE: [number | null, number][] = [
  [null, 4], [12, 6], [8, 2], [7, 8], [null, 4], [5, 3], [7, 1], [8, 4],
]

/** ボス戦の尺八の旋律。8 小節 = 8 分 64 個 */
const BOSS_LEAD: [number | null, number][] = [
  [12, 3], [13, 1], [12, 2], [8, 2],
  [7, 6], [null, 2],
  [5, 3], [7, 1], [8, 2], [7, 2],
  [5, 2], [1, 2], [0, 4],
  [12, 2], [13, 2], [17, 4],
  [19, 6], [null, 2],
  [17, 3], [13, 1], [12, 2], [8, 2],
  [7, 8],
]

/** ボス戦の琴の刻み（16 分。D4 からの半音） */
const BOSS_OSTINATO = [-12, -12, -5, 0, 1, 0, -5, -7]

export class GameMusic {
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private master: GainNode | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private noise: AudioBuffer | null = null
  /** はじいた弦の音（周波数ごとに一度だけ計算して使い回す） */
  private strings = new Map<number, AudioBuffer>()
  private mode: 'field' | 'boss' = 'field'
  private nextTime = 0
  private step = 0
  private intensity = 0
  private leadIndex = 0
  private leadNext = 0
  private fieldPattern = 0
  /** 伸ばしている低音（止めるため） */
  private drones: { stop: (t: number) => void }[] = []

  start(): void {
    const out = sound.output()
    if (!out || this.timer) return
    const ctx = out.ctx
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.setValueAtTime(0.0001, ctx.currentTime)
    this.master.gain.exponentialRampToValueAtTime(0.85, ctx.currentTime + 2)
    this.master.connect(out.out)
    // 音量をそろえる（太鼓が鳴っても旋律が埋もれないように）
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 10
    comp.ratio.value = 3
    comp.attack.value = 0.006
    comp.release.value = 0.2
    comp.connect(this.master)
    // 残響: 2.6 秒で消えていくノイズを「響き方」として使う（左右で違うノイズにして広がりを出す）
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.6, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const data = ir.getChannelData(c)
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3.5
    }
    const reverb = ctx.createConvolver()
    reverb.buffer = ir
    const wet = ctx.createGain()
    wet.gain.value = 0.28
    this.bus = ctx.createGain()
    this.bus.connect(comp)
    this.bus.connect(reverb).connect(wet).connect(comp)
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const n = this.noise.getChannelData(0)
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1
    this.mode = 'field'
    this.nextTime = ctx.currentTime + 0.1
    this.step = 0
    this.timer = setInterval(() => this.schedule(), 25)
  }

  /** ボス戦の曲へ。太鼓の連打と銅鑼のあと、ボスの曲が始まる */
  toBoss(): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime + 0.05
    this.stopDrones(t + 0.3)
    let at = t
    for (let i = 0; i < 16; i++) {
      this.taiko(at, 0.45 + i * 0.035, i % 2 ? -0.4 : 0.4, i < 12 ? 1.2 : 0.9)
      at += Math.max(0.055, 0.18 - i * 0.008)
    }
    this.taiko(at, 1, 0, 0.8)
    this.gong(at)
    this.mode = 'boss'
    this.intensity = 0
    this.step = 0
    this.leadIndex = 0
    this.leadNext = 0
    this.nextTime = at + 1.2
  }

  /** 0〜1。大きいほど楽器が増え、激しくなる */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const ctx = this.ctx, master = this.master
    if (!ctx || !master) return
    const t = ctx.currentTime
    this.stopDrones(t + 2)
    master.gain.cancelScheduledValues(t)
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t)
    master.gain.exponentialRampToValueAtTime(0.0001, t + 2)
    setTimeout(() => master.disconnect(), 2300)
    this.ctx = this.bus = this.master = null
  }

  private get stepSec(): number {
    return 60 / (this.mode === 'boss' ? 138 : 76) / 4 // 16 分音符 1 つ
  }

  private schedule(): void {
    const ctx = this.ctx
    if (!ctx) return
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      if (this.nextTime >= ctx.currentTime - 0.05) {
        if (this.mode === 'field') this.fieldStep(this.step, this.nextTime)
        else this.bossStep(this.step, this.nextTime)
      }
      this.nextTime += this.stepSec
      this.step = (this.step + 1) % (16 * 16)
    }
  }

  // ------------------------------------------------------------------ 道中の曲
  private fieldStep(step: number, t: number): void {
    const bar = Math.floor(step / 16), inBar = step % 16
    const hot = this.intensity
    const S = this.stepSec
    // 持続低音: 4 小節ごとに張り直す（12〜15 小節目だけ「ソとレ」に移って、少し景色を変える）
    if (inBar === 0 && bar % 4 === 0) {
      const root = bar === 12 ? -19 : -24
      this.stopDrones(t + 0.4)
      this.drone(t, d(root), S * 64, 0.05)
      this.drone(t, d(root + 7), S * 64, 0.035)
    }
    // 太鼓: 心臓の鼓動のように「ドン、ドン」。影が近いと締太鼓が刻む
    if (inBar === 0) this.taiko(t, 0.7, 0, 0.8)
    if (inBar === 3) this.taiko(t, 0.45, 0, 0.8)
    if (hot > 0.35 && (inBar === 8 || inBar === 11)) this.taiko(t, 0.35, inBar === 8 ? -0.3 : 0.3, 1.2)
    if (hot > 0.65 && inBar % 2 === 1) this.taiko(t, 0.14, inBar % 4 === 1 ? 0.4 : -0.4, 2.2)
    // 琴: 2 小節ごとに音型を選び直す。影が近いと 16 分で細かくなる
    if (inBar === 0 && bar % 2 === 0) this.fieldPattern = Math.floor(Math.random() * FIELD_PATTERNS.length)
    const pat = FIELD_PATTERNS[this.fieldPattern]
    if (inBar % 2 === 0) {
      const idx = pat[inBar / 2]
      if (idx !== null) this.pluck(t, d(MIYAKO[idx]), 0.22, Math.sin(step) * 0.4)
    } else if (hot > 0.55) {
      const idx = pat[(inBar - 1) / 2]
      if (idx !== null) this.pluck(t, d(MIYAKO[Math.max(0, idx - 2)]), 0.1, -Math.sin(step) * 0.4)
    }
    // 尺八: 8 小節に 1 度、静かに吹く（影が少ないとき）
    if (hot < 0.5 && bar % 8 === 4 && inBar % 2 === 0) {
      const eighth = (bar - 4) * 8 + inBar / 2
      if (eighth === 0) {
        this.leadIndex = 0
        this.leadNext = 0
      }
      if (eighth === this.leadNext && this.leadIndex < FIELD_FLUTE.length) {
        const [note, len] = FIELD_FLUTE[this.leadIndex]
        if (note !== null) this.shakuhachi(t, d(note), len * S * 2, 0.1, 0.2)
        this.leadNext += len
        this.leadIndex++
      }
    }
  }

  // ------------------------------------------------------------------ ボス戦の曲
  private bossStep(step: number, t: number): void {
    const bar = Math.floor(step / 16), inBar = step % 16
    const hot = this.intensity
    const S = this.stepSec
    const section = bar < 4 ? 'intro' : bar < 12 ? 'main' : 'climax'
    // 9〜12 小節は「ソ」へ移って緊張を高め、13 小節で「レ」へ戻る
    const shift = bar >= 8 && bar < 12 ? 5 : 0

    // 持続低音（4 小節ごと）
    if (inBar === 0 && bar % 4 === 0) {
      this.stopDrones(t + 0.3)
      this.drone(t, d(-24 + shift), S * 64, 0.07)
      this.drone(t, d(-17 + shift), S * 64, 0.05)
      if (section === 'climax') this.drone(t, d(-11), S * 64, 0.03) // ミ♭ を重ねて、不穏な響きに
    }

    // 太鼓の合奏: 大太鼓（真ん中）・締太鼓（左右）
    const big: Record<number, number> = { 0: 1, 3: 0.55, 6: 0.75, 8: 0.85, 11: 0.55, 14: 0.8 }
    if (big[inBar]) this.taiko(t, big[inBar], 0, 0.8)
    if (inBar % 4 === 2) this.taiko(t, 0.4, inBar % 8 === 2 ? -0.45 : 0.45, 1.6)
    if (section !== 'intro' && inBar % 2 === 1) this.taiko(t, 0.15 + hot * 0.08, inBar % 4 === 1 ? 0.5 : -0.5, 2.3)
    if (bar % 4 === 3 && inBar >= 8) this.taiko(t, 0.4 + (inBar - 8) * 0.06, inBar % 2 ? 0.4 : -0.4, 1.2)

    // 琴の刻み（16 分）
    const o = BOSS_OSTINATO[inBar % BOSS_OSTINATO.length] + shift
    this.pluck(t, d(o), inBar % 4 === 0 ? 0.24 : 0.15, inBar % 2 ? 0.3 : -0.3)
    if (section === 'climax' || hot >= 0.6) this.pluck(t, d(o + 12), 0.08, inBar % 2 ? -0.5 : 0.5)

    if (section === 'intro') return

    // 尺八（主旋律）・篠笛（最高潮で 1 オクターブ上）
    if (inBar % 2 === 0) {
      const eighth = (bar - (section === 'main' ? 4 : 12)) * 8 + inBar / 2
      if (eighth === 0) {
        this.leadIndex = 0
        this.leadNext = 0
      }
      if (eighth === this.leadNext) {
        const [note, len] = BOSS_LEAD[this.leadIndex % BOSS_LEAD.length]
        if (note !== null) {
          const n = note + shift
          if (section === 'climax') this.fue(t, d(n + 12), len * S * 2, 0.08, -0.15)
          else this.shakuhachi(t, d(n), len * S * 2, 0.15, 0.15)
        }
        this.leadNext += len
        this.leadIndex++
      }
    }

    // 鐘（追い詰めたとき・最高潮）
    if ((section === 'climax' || hot >= 0.5) && (inBar === 4 || inBar === 12)) this.kane(t)
    if (bar === 12 && inBar === 0) this.gong(t)
  }

  // ------------------------------------------------------------------ 楽器
  /** 音量の山（立ち上がり → 減衰）。pan で左右へ振る */
  private voice(t: number, peak: number, attack: number, decay: number, pan: number): GainNode {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, pan))
    g.connect(p).connect(this.bus!)
    return g
  }

  /**
   * はじいた弦の音（カープラス・ストロング法）。
   * 弦 1 周ぶんの長さの「ざらざらした音」を用意し、それを少しずつ平均しながらくり返すと、
   * 高い成分から先に消えていき、本物の弦のような音になる。周波数ごとに一度だけ計算する
   */
  private stringBuffer(f: number): AudioBuffer {
    const key = Math.round(f * 10)
    const hit = this.strings.get(key)
    if (hit) return hit
    const ctx = this.ctx!
    const sr = ctx.sampleRate
    const len = Math.floor(sr * 2.2)
    const buf = ctx.createBuffer(1, len, sr)
    const out = buf.getChannelData(0)
    const period = Math.max(2, Math.round(sr / f))
    const ring = new Float32Array(period)
    // はじく瞬間: 少しなめらかにしたノイズ（爪ではじいた硬すぎない音）
    let prev = 0
    for (let i = 0; i < period; i++) {
      const v = Math.random() * 2 - 1
      ring[i] = (v + prev) * 0.5
      prev = v
    }
    // 高い音ほど早く減衰させる（低い弦は長く響く）
    const decay = 0.996 - Math.min(0.006, f / 200000)
    let idx = 0
    for (let i = 0; i < len; i++) {
      const next = (idx + 1) % period
      const v = ring[idx]
      out[i] = v
      ring[idx] = decay * 0.5 * (v + ring[next])
      idx = next
    }
    this.strings.set(key, buf)
    return buf
  }

  /** 琴・三味線: はじいた弦の音を鳴らす */
  private pluck(t: number, f: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.stringBuffer(f)
    const g = this.voice(t, v, 0.001, 1.8, pan)
    // 弦の胴鳴り: 少しだけ中音を持ち上げる
    const body = ctx.createBiquadFilter()
    body.type = 'peaking'
    body.frequency.value = 900
    body.gain.value = 4
    src.connect(body).connect(g)
    src.start(t)
    src.stop(t + 2)
  }

  /** 和太鼓: 音程が急に下がる低い音 + 皮をたたくざらつき。pitch で大太鼓 / 締太鼓 */
  private taiko(t: number, v: number, pan: number, pitch: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(140 * pitch, t)
    o.frequency.exponentialRampToValueAtTime(48 * pitch, t + 0.22)
    o.connect(this.voice(t, v, 0.003, 0.6 / pitch, pan))
    o.start(t)
    o.stop(t + 0.75)
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1500 * pitch
    n.connect(lp).connect(this.voice(t, v * 0.45, 0.002, 0.07, pan))
    n.start(t, Math.random() * 0.5)
    n.stop(t + 0.1)
  }

  /** 銅鑼: 低いうねる音が長く響く */
  private gong(t: number): void {
    const ctx = this.ctx!
    for (const [f, v] of [[82, 0.3], [123, 0.17], [178, 0.12], [241, 0.08], [311, 0.05]]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(f * 1.02, t)
      o.frequency.exponentialRampToValueAtTime(f, t + 1.5)
      o.connect(this.voice(t, v, 0.01, 4.5, 0))
      o.start(t)
      o.stop(t + 4.6)
    }
  }

  /** 持続低音: 弦の合奏のような柔らかい音を伸ばし続ける（stopDrones で止める） */
  private drone(t: number, f: number, dur: number, v: number): void {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + 1.5)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 700
    lp.connect(g).connect(this.bus!)
    const oscs = [-5, 5].map((det) => {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 2)
      return o
    })
    this.drones.push({
      stop: (at: number) => {
        g.gain.cancelScheduledValues(at)
        g.gain.setTargetAtTime(0.0001, at, 0.5)
        for (const o of oscs) o.stop(at + 2.5)
      },
    })
  }

  private stopDrones(at: number): void {
    for (const dr of this.drones) dr.stop(at)
    this.drones = []
  }

  /** 尺八: 息のノイズを細い共鳴に通した音と、揺れる正弦波。少し低いところから音程をすくい上げる */
  private shakuhachi(t: number, f: number, dur: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + 0.09)
    g.gain.setValueAtTime(v * 0.8, t + dur * 0.75)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p).connect(this.bus!)
    // 管の鳴り（正弦波 + 少しの倍音）。伸ばすほど揺れ（ビブラート）が深くなる
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f * 0.96, t)
    o.frequency.exponentialRampToValueAtTime(f, t + 0.12)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 5
    const depth = ctx.createGain()
    depth.gain.setValueAtTime(0, t)
    depth.gain.linearRampToValueAtTime(f * 0.01, t + Math.min(0.7, dur * 0.6))
    lfo.connect(depth).connect(o.frequency)
    const og = ctx.createGain()
    og.gain.value = 0.7
    o.connect(og).connect(g)
    // 息: ノイズを、吹いている音の高さで細く共鳴させる
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    n.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = f
    bp.Q.value = 18
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(2.2, t)
    ng.gain.exponentialRampToValueAtTime(1, t + 0.2)
    n.connect(bp).connect(ng).connect(g)
    for (const node of [o, lfo]) {
      node.start(t)
      node.stop(t + dur + 0.05)
    }
    n.start(t, Math.random() * 0.5)
    n.stop(t + dur + 0.05)
  }

  /** 篠笛: 尺八より高く澄んだ笛。息は少なめ */
  private fue(t: number, f: number, dur: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const g = this.voice(t, v, 0.05, dur, pan)
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.setValueAtTime(f * 0.98, t)
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 6
    const depth = ctx.createGain()
    depth.gain.value = f * 0.006
    lfo.connect(depth).connect(o.frequency)
    o.connect(g)
    o.start(t)
    lfo.start(t)
    o.stop(t + dur + 0.05)
    lfo.stop(t + dur + 0.05)
  }

  /** 鐘（金物） */
  private kane(t: number): void {
    const ctx = this.ctx!
    for (const [f, v, pan] of [[1870, 0.04, 0.3], [2630, 0.028, -0.3]]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      o.connect(this.voice(t, v, 0.001, 0.5, pan))
      o.start(t)
      o.stop(t + 0.55)
    }
  }
}
