// 戦いの BGM。音声ファイルは使わず、Web Audio でその場で鳴らす（土台は lib/sound.ts の output()）。
//
// 2 つの曲がある:
//   field  道中（波）の曲。テンポ 96、D マイナー、16 小節。8 分で刻む低音と太鼓、低い合唱。
//          影が近いほど（intensity）太鼓が増え、弦の刻みと高い合唱が入る
//   boss   ボス戦の曲。テンポ 150、16 小節で展開する:
//            1〜4 小節  導入   太鼓・低音・弦の刻みだけで、じわじわ高める（最後に太鼓の連打）
//            5〜12 小節 主旋律 尺八風の旋律・三味線風の刻み・合唱
//            13〜16 小節 最高潮 旋律が 1 オクターブ上へ。合唱が厚くなり、鐘と細かい刻み
//          登場の瞬間に太鼓の連打と銅鑼（toBoss）。ボスを追い詰めるほど（intensity）音が重なる
//
// 音を太く・重くするために:
//   - すべての音を「ほどよく歪ませる（サチュレーション）→ 音量をそろえる（コンプレッサー）」に通す
//   - 低音には 1 オクターブ下の正弦波（サブベース）を重ね、太鼓にはキック（低い芯の音）を足す
//   - 残響（リバーブ）で森の中で鳴っている響きを、楽器ごとに左右へ振り分けて広がりを出す
//
// しくみ: 25 ミリ秒ごとに「少し先（0.15 秒）までに鳴らす音」を予約する（音のタイミングがずれないため）。
// **使い終わったら必ず stop() を呼ぶこと**（呼ばないと鳴り続ける）。

import { sound } from '../../lib/sound'

const LOOKAHEAD = 0.15
/** A4 から半音 n 個上の周波数 */
const hz = (n: number) => 440 * 2 ** (n / 12)

// 音の高さは A4 からの半音で書く。D2 = -31, D3 = -19, D4 = -7, D5 = 5
interface Chord { root: number; tones: number[] }
const Dm: Chord = { root: -31, tones: [0, 3, 7] }
const Bb: Chord = { root: -35, tones: [0, 4, 7] }
const C: Chord = { root: -33, tones: [0, 4, 7] }
const A: Chord = { root: -36, tones: [0, 4, 7] }
const Gm: Chord = { root: -38, tones: [0, 3, 7] }
const F: Chord = { root: -40, tones: [0, 4, 7] }

/** 道中: 16 小節（Dm を長く引きずり、終わりで A に向かって緊張を高める） */
const FIELD_CHORDS: Chord[] = [Dm, Dm, Bb, C, Dm, Dm, Gm, A, Dm, Dm, Bb, F, Gm, Bb, A, A]
/** ボス: 4 小節の進行（Dm → B♭ → C → A）を 4 回 */
const BOSS_CHORDS: Chord[] = [Dm, Bb, C, A, Dm, Bb, C, A, Dm, Bb, C, A, Dm, Bb, C, A]

/** ボス戦の尺八の旋律（D4 からの半音、長さは 8 分音符いくつぶんか）。8 小節 = 8 分 64 個 */
const BOSS_LEAD: [number | null, number][] = [
  [12, 3], [10, 1], [7, 2], [8, 2],
  [7, 4], [5, 2], [3, 2],
  [5, 3], [7, 1], [8, 2], [10, 2],
  [12, 4], [null, 2], [14, 2],
  [15, 3], [14, 1], [12, 2], [10, 2],
  [12, 6], [null, 2],
  [11, 3], [12, 1], [14, 2], [16, 2],
  [19, 6], [null, 2],
]

/** ボス戦の三味線風の刻み（8 分。D4 からの半音。null は休み）。4 小節ぶん */
const BOSS_PLUCK: (number | null)[] = [
  0, 0, 12, 0, 10, 0, 7, 8, 0, 0, 12, 0, 15, 14, 12, 10,
  0, 0, 12, 0, 10, 12, 14, 15, 11, 11, 14, 11, 16, 14, 11, 9,
]

export class GameMusic {
  private ctx: AudioContext | null = null
  /** すべての音の集まる先（ここから「そのまま」と「残響」に分かれ、歪み → コンプレッサーへ） */
  private bus: GainNode | null = null
  private master: GainNode | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private noise: AudioBuffer | null = null
  private mode: 'field' | 'boss' = 'field'
  private nextTime = 0
  private step = 0
  private intensity = 0
  /** ボスの旋律の位置 */
  private leadIndex = 0
  private leadNext = 0

  start(): void {
    const out = sound.output()
    if (!out || this.timer) return
    const ctx = out.ctx
    this.ctx = ctx
    // 出口: 歪み → コンプレッサー → 全体の音量 → 画面右上の音量（out）
    this.master = ctx.createGain()
    this.master.gain.setValueAtTime(0.0001, ctx.currentTime)
    this.master.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 2)
    this.master.connect(out.out)
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.knee.value = 8
    comp.ratio.value = 4
    comp.attack.value = 0.005
    comp.release.value = 0.18
    comp.connect(this.master)
    const sat = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6) // なめらかに頭を丸める（耳ざわりな割れ方をしない）
    }
    sat.curve = curve
    sat.oversample = '2x'
    const drive = ctx.createGain()
    drive.gain.value = 1.4
    drive.connect(sat).connect(comp)
    // 残響: 2.8 秒で消えていくノイズを「響き方」として使う（左右で違うノイズにして広がりを出す）
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.8, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3
    }
    const reverb = ctx.createConvolver()
    reverb.buffer = ir
    const wet = ctx.createGain()
    wet.gain.value = 0.3
    this.bus = ctx.createGain()
    this.bus.connect(drive)
    this.bus.connect(reverb).connect(wet).connect(drive)
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
    // 太鼓の連打（だんだん速く、強く）
    let at = t
    for (let i = 0; i < 16; i++) {
      this.taiko(at, 0.45 + i * 0.04, i % 2 ? -0.4 : 0.4, 1)
      if (i % 4 === 0) this.kick(at, 0.6)
      at += Math.max(0.05, 0.17 - i * 0.008)
    }
    this.kick(at, 1)
    this.gong(at)
    this.mode = 'boss'
    this.intensity = 0
    this.step = 0
    this.leadIndex = 0
    this.leadNext = 0
    this.nextTime = at + 1.1
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
    master.gain.cancelScheduledValues(t)
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), t)
    master.gain.exponentialRampToValueAtTime(0.0001, t + 2)
    setTimeout(() => master.disconnect(), 2300)
    this.ctx = this.bus = this.master = null
  }

  private get bpm(): number {
    return this.mode === 'boss' ? 150 : 96
  }

  private get stepSec(): number {
    return 60 / this.bpm / 4 // 16 分音符 1 つ
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
    const ch = FIELD_CHORDS[bar]
    const hot = this.intensity
    const S = this.stepSec

    // 合唱: 小節の頭で和音を伸ばす（低い「あー」）。影が近いと 1 オクターブ上も重なる
    if (inBar === 0) {
      for (const tone of ch.tones) this.choir(t, hz(ch.root + 24 + tone), S * 16, 0.07, (tone - 4) * 0.09)
      if (hot > 0.5) for (const tone of ch.tones) this.choir(t, hz(ch.root + 36 + tone), S * 16, 0.035, -(tone - 4) * 0.12)
    }
    // 低音: 8 分で刻む（ところどころ 5 度上へ）
    if (inBar % 2 === 0) {
      const up = inBar === 6 || inBar === 14 ? 7 : 0
      this.bass(t, hz(ch.root + up), S * 1.7, 0.2)
    }
    // 太鼓とキック: 1 拍目・2 拍目の裏・3 拍目。影が近いと 16 分の締太鼓が加わる
    if (inBar === 0 || inBar === 8) this.kick(t, 0.75)
    if (inBar === 0) this.taiko(t, 0.65, 0, 0.9)
    if (inBar === 6 || inBar === 10) this.taiko(t, 0.4, inBar === 6 ? -0.3 : 0.3, 1.1)
    if (hot > 0.35 && inBar % 4 === 3) this.taiko(t, 0.28, 0.35, 1.7)
    if (hot > 0.65 && inBar % 2 === 1) this.taiko(t, 0.16, -0.4, 2.2)
    // 4 小節ごとの終わりに、太鼓をたたみかける
    if (bar % 4 === 3 && inBar >= 12) this.taiko(t, 0.35 + (inBar - 12) * 0.08, inBar % 2 ? 0.4 : -0.4, 1.3)
    // 弦の刻み（影が近いとき）
    if (hot > 0.5) this.strings(t, hz(ch.root + 24 + ch.tones[[0, 1, 2, 1][inBar % 4]]), S * 0.9, 0.03, inBar % 2 ? 0.35 : -0.35)
    // 琴の音: ときどき和音の音をつまびく
    if (inBar % 4 === 2 && Math.random() < 0.5) {
      const tone = ch.tones[Math.floor(Math.random() * 3)]
      this.pluck(t, hz(ch.root + 36 + tone), 0.08, Math.random() * 1.2 - 0.6)
    }
  }

  // ------------------------------------------------------------------ ボス戦の曲
  private bossStep(step: number, t: number): void {
    const bar = Math.floor(step / 16), inBar = step % 16
    const ch = BOSS_CHORDS[bar]
    const hot = this.intensity
    const S = this.stepSec
    const section = bar < 4 ? 'intro' : bar < 12 ? 'main' : 'climax'

    // キックと大太鼓（真ん中）・締太鼓（左右）
    const big: Record<number, number> = { 0: 1, 3: 0.6, 6: 0.8, 8: 0.7, 11: 0.6, 14: 0.9 }
    if (inBar % 4 === 0) this.kick(t, 0.9)
    if (big[inBar]) this.taiko(t, big[inBar], 0, 0.85)
    if (inBar % 4 === 2) this.taiko(t, 0.38, inBar % 8 === 2 ? -0.45 : 0.45, 1.7)
    if (section !== 'intro' && inBar % 2 === 1) this.taiko(t, 0.14 + hot * 0.08, inBar % 4 === 1 ? 0.5 : -0.5, 2.3)
    // 4 小節ごとの終わりに、太鼓の連打（導入の最後は特に強く）
    if (bar % 4 === 3 && inBar >= 8) {
      const strong = bar === 3 ? 1.3 : 1
      this.taiko(t, (0.35 + (inBar - 8) * 0.06) * strong, inBar % 2 ? 0.4 : -0.4, 1.25)
    }

    // 低音（8 分で刻む。サブベースつき）
    if (inBar % 2 === 0) this.bass(t, hz(ch.root + (inBar === 6 || inBar === 14 ? 12 : 0)), S * 1.8, 0.26)

    // 弦の刻み（16 分）。最高潮では 1 オクターブ上も
    const arp = [0, 1, 2, 1]
    const sn = ch.root + 24 + ch.tones[arp[inBar % 4]] + (inBar >= 8 ? 12 : 0)
    this.strings(t, hz(sn), S * 0.9, 0.032 + hot * 0.015, inBar % 2 ? 0.35 : -0.35)
    if (section === 'climax') this.strings(t, hz(sn + 12), S * 0.9, 0.018, inBar % 2 ? -0.5 : 0.5)

    if (section === 'intro') return

    // 合唱（小節の頭で伸ばす）。最高潮では上の声部も
    if (inBar === 0) {
      for (const tone of ch.tones) this.choir(t, hz(ch.root + 24 + tone), S * 16, 0.07 + hot * 0.03, (tone - 4) * 0.1)
      if (section === 'climax') for (const tone of ch.tones) this.choir(t, hz(ch.root + 36 + tone), S * 16, 0.05, -(tone - 4) * 0.12)
    }

    // 三味線風（8 分）
    if (inBar % 2 === 0) {
      const n = BOSS_PLUCK[(step / 2) % BOSS_PLUCK.length]
      if (n !== null) this.pluck(t, hz(-7 + n), 0.1, -0.25)
    }

    // 尺八風の旋律（主旋律は 5〜12 小節、最高潮で頭の 4 小節を 1 オクターブ上で）
    if (inBar % 2 === 0) {
      const eighth = (bar - (section === 'main' ? 4 : 12)) * 8 + inBar / 2
      if (eighth === 0) {
        this.leadIndex = 0
        this.leadNext = 0
      }
      if (eighth === this.leadNext) {
        const [note, len] = BOSS_LEAD[this.leadIndex % BOSS_LEAD.length]
        const up = section === 'climax' ? 12 : 0
        if (note !== null) this.shakuhachi(t, hz(-7 + note + up), len * S * 2, 0.12, 0.12)
        this.leadNext += len
        this.leadIndex++
      }
    }

    // 鐘・細かい刻み（最高潮か、追い詰めたとき）
    if ((section === 'climax' || hot >= 0.5) && (inBar === 4 || inBar === 12)) this.kane(t)
    if ((section === 'climax' || hot >= 0.75) && inBar % 2 === 1) this.hat(t, 0.05)
    // 最高潮の頭で銅鑼
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

  /** キック: 一瞬で下がる低い音（曲の芯になる重さ） */
  private kick(t: number, v: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, t)
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12)
    o.connect(this.voice(t, v * 0.9, 0.002, 0.32, 0))
    o.start(t)
    o.stop(t + 0.4)
  }

  /** 和太鼓: 音程が急に下がる低い音 + 皮をたたくざらつき。pitch で大太鼓 / 締太鼓 */
  private taiko(t: number, v: number, pan: number, pitch: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(130 * pitch, t)
    o.frequency.exponentialRampToValueAtTime(40 * pitch, t + 0.25)
    o.connect(this.voice(t, v, 0.003, 0.55 / pitch, pan))
    o.start(t)
    o.stop(t + 0.7)
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1400 * pitch
    n.connect(lp).connect(this.voice(t, v * 0.5, 0.002, 0.08, pan))
    n.start(t, Math.random() * 0.5)
    n.stop(t + 0.12)
  }

  /** 銅鑼: 低いうねる音が長く響く */
  private gong(t: number): void {
    const ctx = this.ctx!
    for (const [f, v] of [[82, 0.35], [123, 0.2], [178, 0.14], [241, 0.09], [311, 0.06]]) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(f * 1.02, t)
      o.frequency.exponentialRampToValueAtTime(f, t + 1.5)
      o.connect(this.voice(t, v, 0.01, 4.5, 0))
      o.start(t)
      o.stop(t + 4.6)
    }
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 400
    n.connect(bp).connect(this.voice(t, 0.35, 0.005, 0.6, 0))
    n.start(t)
    n.stop(t + 0.7)
  }

  /** 低音: のこぎり波（こもらせる）に、1 オクターブ下の正弦波（サブベース）を重ねる */
  private bass(t: number, f: number, dur: number, v: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 3
    lp.frequency.setValueAtTime(900, t)
    lp.frequency.exponentialRampToValueAtTime(180, t + Math.min(0.3, dur))
    o.connect(lp).connect(this.voice(t, v, 0.008, dur, 0))
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.value = f / 2
    sub.connect(this.voice(t, v * 0.9, 0.01, dur, 0))
    for (const x of [o, sub]) {
      x.start(t)
      x.stop(t + dur + 0.05)
    }
  }

  /** 合唱: のこぎり波を「あ」の口の形の共鳴（700Hz と 1150Hz）に通す。ゆっくり立ち上がり、少し揺れる */
  private choir(t: number, f: number, dur: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.6, dur * 0.3))
    g.gain.setValueAtTime(v, t + dur * 0.8)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p).connect(this.bus!)
    for (const detune of [-9, 0, 8]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = detune
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 4.5 + Math.random()
      const depth = ctx.createGain()
      depth.gain.value = 5
      lfo.connect(depth).connect(o.detune)
      for (const [ff, q, gv] of [[700, 5, 1], [1150, 7, 0.6], [2600, 8, 0.25]]) {
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = ff
        bp.Q.value = q
        const fg = ctx.createGain()
        fg.gain.value = gv
        o.connect(bp).connect(fg).connect(g)
      }
      o.start(t)
      lfo.start(t)
      o.stop(t + dur + 0.1)
      lfo.stop(t + dur + 0.1)
    }
  }

  /** 弦の刻み: 短いのこぎり波 2 本（少しずらす）を、こもらせて鳴らす */
  private strings(t: number, f: number, dur: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 2600
    lp.connect(this.voice(t, v, 0.008, dur, pan))
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = f
      o.detune.value = det
      o.connect(lp)
      o.start(t)
      o.stop(t + dur + 0.05)
    }
  }

  /** 三味線・琴風: はじいて、こもらせていく */
  private pluck(t: number, f: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.setValueAtTime(f * 1.012, t)
    o.frequency.exponentialRampToValueAtTime(f, t + 0.04)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 5
    lp.frequency.setValueAtTime(f * 9, t)
    lp.frequency.exponentialRampToValueAtTime(f * 1.4, t + 0.35)
    o.connect(lp).connect(this.voice(t, v, 0.002, 0.45, pan))
    o.start(t)
    o.stop(t + 0.5)
  }

  /** 尺八風: 少し低いところから音程をすくい上げ、揺れ（ビブラート）と息の音をのせる */
  private shakuhachi(t: number, f: number, dur: number, v: number, pan: number): void {
    const ctx = this.ctx!
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(v, t + 0.07)
    g.gain.setValueAtTime(v * 0.85, t + dur * 0.7)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p).connect(this.bus!)
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f * 0.97, t)
    o.frequency.exponentialRampToValueAtTime(f, t + 0.09)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 5.2
    const depth = ctx.createGain()
    depth.gain.setValueAtTime(0, t)
    depth.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.6, dur * 0.6)) // 伸ばすほど揺れが深くなる
    lfo.connect(depth).connect(o.frequency)
    const o2 = ctx.createOscillator()
    o2.type = 'triangle'
    o2.frequency.value = f * 2
    const g2 = ctx.createGain()
    g2.gain.value = 0.18
    o.connect(g)
    o2.connect(g2).connect(g)
    // 息の音
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = f * 2
    bp.Q.value = 3
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.5, t)
    ng.gain.exponentialRampToValueAtTime(0.12, t + 0.15)
    n.connect(bp).connect(ng).connect(g)
    for (const node of [o, o2, lfo]) {
      node.start(t)
      node.stop(t + dur + 0.05)
    }
    n.start(t, Math.random() * 0.3)
    n.stop(t + dur + 0.05)
  }

  /** 鐘（金物） */
  private kane(t: number): void {
    const ctx = this.ctx!
    for (const [f, v, pan] of [[1870, 0.05, 0.3], [2630, 0.035, -0.3]]) {
      const o = ctx.createOscillator()
      o.type = 'square'
      o.frequency.value = f
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 1500
      o.connect(hp).connect(this.voice(t, v, 0.001, 0.25, pan))
      o.start(t)
      o.stop(t + 0.3)
    }
  }

  private hat(t: number, v: number): void {
    const ctx = this.ctx!
    const n = ctx.createBufferSource()
    n.buffer = this.noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7000
    n.connect(hp).connect(this.voice(t, v, 0.001, 0.04, Math.random() - 0.5))
    n.start(t, Math.random() * 0.5)
    n.stop(t + 0.06)
  }
}
