// シティの音。音声ファイルは使わず、Web Audio で全部その場で合成する。
//
// リアルに聞こえるように、次のことをしている:
//   3D の定位   音を出す物の位置に PannerNode（HRTF）を置き、カメラの位置と向きを「耳」にする。
//               右から来たパトカーは右から聞こえ、遠いほど小さくなる
//   ドップラー  近づく車は高く、遠ざかる車は低く聞こえる（速度から音程を計算する）
//   残響        街のビルに反響する響き（乱数で作ったインパルス応答を畳み込む）
//   エンジン    発振器のピーという音ではなく、「燃焼 1 回ぶんの破裂音」を気筒の数だけ少しずつ
//               ばらつかせて並べた音を作り、回転数に合わせて速く再生する。それを排気管・車体の
//               共鳴（決まった高さの山）に通すので、回転が変わっても響きの色は変わらない（実車と同じ）。
//               吸気のうなり・負荷でかかる歪み・ターボの笛とブローオフ・アフターファイアを重ねる
//   衝突        低い地響き・金属がひしゃげて裂ける音（短い破裂を何十も散らす）・ガラスが砕ける音
//   環境音      遠くの車の流れ・昼の鳥・夜の虫・雨・雪の日の風・港のカモメ・遠くのサイレン
//
// 鳴らしっぱなしの音があるので、画面を閉じるときは必ず stop() を呼ぶこと。

import { sound } from '../../lib/sound'
import type { ThemeId } from './sim/maps'
import type { GameEvent, Vehicle } from './sim/game'
import type { Heli } from './sim/heli'
import { forwardSpeed, speedOf } from './sim/vehicle'

const C = 343 // 音の速さ（m/s）
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const rnd = (a: number, b: number) => a + Math.random() * (b - a)

/** 車種ごとのエンジンの性格 */
const ENGINES: Record<string, { idle: number; red: number; gears: number[]; cyl: number; turbo: boolean; tone: number }> = {
  sport: { idle: 950, red: 7800, gears: [3.4, 2.3, 1.7, 1.3, 1.05, 0.85], cyl: 6, turbo: true, tone: 1.2 },
  sedan: { idle: 750, red: 6200, gears: [3.2, 2.0, 1.4, 1.05, 0.8], cyl: 4, turbo: false, tone: 1 },
  hatch: { idle: 850, red: 6500, gears: [3.5, 2.1, 1.45, 1.1, 0.85], cyl: 4, turbo: false, tone: 1.1 },
  taxi: { idle: 750, red: 5800, gears: [3.0, 1.9, 1.35, 1.0, 0.78], cyl: 4, turbo: false, tone: 0.95 },
  van: { idle: 700, red: 4800, gears: [3.6, 2.2, 1.45, 1.0, 0.75], cyl: 4, turbo: true, tone: 0.8 },
  suv: { idle: 700, red: 5800, gears: [3.3, 2.1, 1.5, 1.1, 0.85, 0.7], cyl: 8, turbo: false, tone: 0.85 },
  police: { idle: 800, red: 6800, gears: [3.3, 2.2, 1.6, 1.2, 0.95, 0.78], cyl: 8, turbo: false, tone: 1 },
}

/** 乱数から作る街の残響（2 秒ほどで消える、左右で少し違うノイズ） */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      const t = i / len
      // 最初の反射（ビルの壁）をいくつか立てる
      const early = i < ctx.sampleRate * 0.12 && Math.random() < 0.004 ? 1.5 : 0
      d[i] = ((Math.random() * 2 - 1) + early) * (1 - t) ** decay
    }
  }
  return buf
}

function noiseBuffer(ctx: AudioContext, seconds: number, color: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    if (color === 'white') d[i] = w
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
    } else {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    }
  }
  return buf
}

/**
 * エンジンの元の音: 基準の回転（1 秒に PULSE_RATE 回の燃焼）で、燃焼 1 回ごとの破裂音を並べた 3 秒ぶん。
 * 1 回ごとに強さ・間隔・音色を少しずつばらつかせる（全部同じだと機械的なブザー音になる）。
 * 気筒ごとに癖をつけて、低い「ドロドロ」という周期（不等間隔の鼓動）も出す
 */
const PULSE_RATE = 50
function enginePulses(ctx: AudioContext, cyl: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.floor(sr * 3)
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  const period = sr / PULSE_RATE
  const quirks = Array.from({ length: cyl }, () => 0.75 + Math.random() * 0.5)
  let t = 0, k = 0
  while (t < len) {
    const amp = quirks[k % cyl] * (0.85 + Math.random() * 0.3)
    const decay = period * (0.18 + Math.random() * 0.06)
    const start = Math.floor(t)
    for (let i = 0; i < period * 1.2 && start + i < len; i++) {
      const e = Math.exp(-i / decay)
      // 立ち上がりの鋭い「パン」と、あとに続くざらついた排気の流れ
      const crack = i < 12 ? (1 - i / 12) * 1.4 : 0
      d[start + i] += amp * (e * (0.55 * Math.sin(i / period * Math.PI * 2 * 1.5) + (Math.random() * 2 - 1) * 0.45) + crack * (Math.random() * 0.6 + 0.4))
    }
    t += period * (0.97 + Math.random() * 0.06)
    k++
  }
  // ループのつなぎ目でプチッと鳴らないように、両端をなめらかに
  for (let i = 0; i < 400; i++) { d[i] *= i / 400; d[len - 1 - i] *= i / 400 }
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]))
  for (let i = 0; i < len; i++) d[i] /= peak
  return buf
}

/** 軽い歪み（アクセルを踏み込むとざらつく） */
function distortionCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x))
  }
  return c
}

interface Voice {
  /** エンジン（破裂音の列）。サイレンでは使わない */
  src: AudioBufferSourceNode | null
  osc: OscillatorNode
  osc2: OscillatorNode
  filter: BiquadFilterNode
  gain: GainNode
  panner: PannerNode
  id: number
}

export class CityAudio {
  private ctx: AudioContext | null = null
  private bus!: GainNode
  private dry!: GainNode
  private wet!: GainNode
  private white!: AudioBuffer
  private pink!: AudioBuffer
  private brown!: AudioBuffer
  private nodes: AudioScheduledSourceNode[] = []
  // 自分の車
  private eng: {
    src: AudioBufferSourceNode; intake: BiquadFilterNode; drive: WaveShaperNode
    mainGain: GainNode; subGain: GainNode; rasp: BiquadFilterNode; raspGain: GainNode
    turbo: OscillatorNode; turboGain: GainNode
  } | null = null
  /** 車種（気筒数）ごとの破裂音の列 */
  private pulses = new Map<number, AudioBuffer>()
  private engineType = ''
  private rpm = 800
  private gear = 0
  private shiftT = 0
  private lastThrottle = 0
  private tire!: { filter: BiquadFilterNode; gain: GainNode; tone: OscillatorNode; toneGain: GainNode }
  private road!: { filter: BiquadFilterNode; gain: GainNode }
  private wind!: { filter: BiquadFilterNode; gain: GainNode }
  private horn!: { gain: GainNode }
  // 環境音
  private amb!: { traffic: GainNode; trafficF: BiquadFilterNode; weather: GainNode; weatherF: BiquadFilterNode }
  private npc: Voice[] = []
  /** ヘリのローター（バラバラという羽根の音）。ヘリがいるあいだだけ鳴らす */
  private rotor: { gain: GainNode; panner: PannerNode; lfo: OscillatorNode; filter: BiquadFilterNode } | null = null
  private sirens: (Voice & { phase: number })[] = []
  private listener = { x: 0, y: 0, z: 0, vx: 0, vz: 0 }
  private theme: ThemeId = 'bay'
  private time = 0
  private nextBird = 2
  private nextDistant = 8
  private lastCrash = 0
  started = false

  /** 最初のキー入力・クリックのあとで呼ぶ（ブラウザは操作があるまで音を出させない） */
  start(theme: ThemeId): void {
    if (this.started) return
    const o = sound.output()
    if (!o) return
    this.started = true
    this.theme = theme
    const ctx = (this.ctx = o.ctx)
    this.white = noiseBuffer(ctx, 3, 'white')
    this.pink = noiseBuffer(ctx, 4, 'pink')
    this.brown = noiseBuffer(ctx, 4, 'brown')

    // 音の通り道: 全部 bus に集め、そのまま（dry）と残響（wet）に分けて出す
    this.bus = ctx.createGain()
    this.dry = ctx.createGain()
    this.wet = ctx.createGain()
    const conv = ctx.createConvolver()
    conv.buffer = makeImpulse(ctx, theme === 'metro' ? 2.6 : 1.8, 3.2)
    this.wet.gain.value = theme === 'metro' ? 0.28 : 0.18
    const comp = ctx.createDynamicsCompressor() // 爆発などで音が割れないように
    comp.threshold.value = -14
    comp.ratio.value = 4
    this.bus.connect(this.dry).connect(comp)
    this.bus.connect(conv).connect(this.wet).connect(comp)
    comp.connect(o.out)

    this.buildTires()
    this.buildAmbience()
    this.buildHorn()
  }

  private loop(buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.playbackRate.value = rate
    s.loopStart = Math.random() * 0.5
    s.start(ctx.currentTime, Math.random() * buf.duration)
    this.nodes.push(s)
    return s
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    return f
  }

  private gainNode(v = 0): GainNode {
    const g = this.ctx!.createGain()
    g.gain.value = v
    return g
  }

  private osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.ctx!.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.start()
    this.nodes.push(o)
    return o
  }

  private set(p: AudioParam, v: number, tc = 0.03): void {
    p.setTargetAtTime(v, this.ctx!.currentTime, tc)
  }

  /** 位置のある音の出口 */
  private panner(x: number, y: number, z: number, ref = 6, roll = 1.2): PannerNode {
    const p = this.ctx!.createPanner()
    p.panningModel = 'HRTF'
    p.distanceModel = 'inverse'
    p.refDistance = ref
    p.maxDistance = 1500
    p.rolloffFactor = roll
    p.positionX.value = x
    p.positionY.value = y
    p.positionZ.value = z
    p.connect(this.bus)
    return p
  }

  // --- 自分の車 --------------------------------------------------------------------------

  private pulseBuffer(cyl: number): AudioBuffer {
    let b = this.pulses.get(cyl)
    if (!b) { b = enginePulses(this.ctx!, cyl); this.pulses.set(cyl, b) }
    return b
  }

  private buildEngine(type: string): void {
    const ctx = this.ctx!
    if (this.eng) {
      for (const n of [this.eng.src, this.eng.turbo]) { try { n.stop() } catch { /* 止め済み */ } }
    }
    const spec = ENGINES[type] ?? ENGINES.sedan
    this.engineType = type
    const src = this.loop(this.pulseBuffer(spec.cyl))
    const drive = ctx.createWaveShaper()
    drive.curve = distortionCurve(1.5)
    drive.oversample = '4x'
    const intake = this.filter('lowpass', 900, 0.9) // アクセルを踏むほど開いて、音が明るく荒くなる
    // 排気管・車体の共鳴（回転数に関係なく決まった高さで響く）
    const boom = this.filter('peaking', spec.cyl >= 8 ? 85 : 120, 1.2)
    boom.gain.value = 9
    const pipe = this.filter('peaking', spec.cyl >= 6 ? 380 : 470, 2)
    pipe.gain.value = 6
    const mainGain = this.gainNode()
    src.connect(drive).connect(intake).connect(boom).connect(pipe).connect(mainGain).connect(this.bus)
    // 腹に響く低音（同じ破裂音の低いところだけ）
    const subLp = this.filter('lowpass', 140, 0.8)
    const subGain = this.gainNode()
    src.connect(subLp).connect(subGain).connect(this.bus)
    // 吸気と排気の流れのざらつき（ノイズを回転数の高さの帯だけ通す）
    const raspSrc = this.loop(this.pink)
    const rasp = this.filter('bandpass', 400, 1.2)
    const raspGain = this.gainNode()
    raspSrc.connect(rasp).connect(raspGain).connect(this.bus)
    const turbo = this.osc('sine', 2000)
    const turboGain = this.gainNode()
    turbo.connect(turboGain).connect(this.bus)
    this.eng = { src, intake, drive, mainGain, subGain, rasp, raspGain, turbo, turboGain }
    this.gear = 0
  }

  private buildTires(): void {
    // タイヤの鳴き: 帯域を絞ったノイズ + うなる音
    const src = this.loop(this.pink, 1.3)
    const filter = this.filter('bandpass', 1400, 7)
    const gain = this.gainNode()
    src.connect(filter).connect(gain).connect(this.bus)
    const tone = this.osc('triangle', 1100)
    const vib = this.osc('sine', 13)
    const vibG = this.gainNode(40)
    vib.connect(vibG).connect(tone.frequency)
    const toneGain = this.gainNode()
    tone.connect(this.filter('bandpass', 1200, 3)).connect(toneGain).connect(this.bus)
    this.tire = { filter, gain, tone, toneGain }
    // 路面のゴーッという音
    const rsrc = this.loop(this.brown)
    const rf = this.filter('lowpass', 300)
    const rg = this.gainNode()
    rsrc.connect(rf).connect(rg).connect(this.bus)
    this.road = { filter: rf, gain: rg }
    // 風切り音
    const wsrc = this.loop(this.pink, 0.8)
    const wf = this.filter('bandpass', 900, 0.8)
    const wg = this.gainNode()
    wsrc.connect(wf).connect(wg).connect(this.bus)
    this.wind = { filter: wf, gain: wg }
  }

  private buildHorn(): void {
    // 車のクラクション: 少しずれた 2 つの音（長 3 度くらい）を重ね、ラッパのように帯域を絞る
    const g = this.gainNode()
    const bp = this.filter('bandpass', 700, 1.2)
    const drive = this.ctx!.createWaveShaper()
    drive.curve = distortionCurve(4)
    for (const f of [415, 523]) this.osc('square', f).connect(bp)
    bp.connect(drive).connect(g).connect(this.bus)
    this.horn = { gain: g }
  }

  private buildAmbience(): void {
    // 遠くの車の流れ（低いゴーッという音が、ゆっくり大きくなったり小さくなったり）
    const t = this.loop(this.brown, 0.7)
    const tf = this.filter('lowpass', 220)
    const tg = this.gainNode(0.05)
    t.connect(tf).connect(tg).connect(this.bus)
    // 天気（雨・雪の日の風）
    const w = this.loop(this.theme === 'metro' ? this.white : this.pink, 1)
    const wf = this.filter(this.theme === 'metro' ? 'highpass' : 'bandpass', this.theme === 'metro' ? 1800 : 500, 0.9)
    const wg = this.gainNode(this.theme === 'metro' ? 0.07 : this.theme === 'snow' ? 0.05 : 0)
    w.connect(wf).connect(wg).connect(this.bus)
    this.amb = { traffic: tg, trafficF: tf, weather: wg, weatherF: wf }
  }

  /** 回転数とギアを速さから決める（オートマのように自動で変速） */
  private updateEngine(v: Vehicle, dt: number): void {
    if (!this.eng || this.engineType !== v.spec.type) this.buildEngine(v.spec.type)
    const e = this.eng!
    const spec = ENGINES[v.spec.type] ?? ENGINES.sedan
    const speed = Math.abs(forwardSpeed(v.body))
    const thr = clamp(v.controls.throttle, -1, 1)
    const load = Math.max(thr, 0)
    const wheelRpm = (speed / (2 * Math.PI * v.spec.wheelRadius)) * 60 * 3.9 // 3.9 = 最終減速比
    // 変速
    const cur = wheelRpm * spec.gears[this.gear]
    if (cur > spec.red * 0.88 && this.gear < spec.gears.length - 1) { this.gear++; this.shiftT = 0.18; this.clunk() }
    else if (cur < spec.red * 0.34 && this.gear > 0) { this.gear--; this.shiftT = 0.12 }
    this.shiftT = Math.max(0, this.shiftT - dt)
    let target = Math.max(spec.idle, wheelRpm * spec.gears[this.gear])
    // 止まっていてアクセルを踏むと空ぶかし、ホイールスピンでも回転が上がる
    if (speed < 3) target = Math.max(target, spec.idle + load * spec.red * 0.55)
    if (v.controls.handbrake && load > 0) target = Math.max(target, spec.red * 0.8)
    if (this.shiftT > 0) target *= 0.72
    target = Math.min(target, spec.red * 1.02)
    // エンジンは慣性があるので、ゆっくり追いつく（ふかすと速く上がる）
    const rate = target > this.rpm ? 6 + load * 10 : 5
    this.rpm += (target - this.rpm) * Math.min(1, dt * rate)
    // レブリミッター
    const limiter = this.rpm > spec.red * 0.98 && load > 0.5 && Math.sin(this.time * 70) > 0.3 ? 0.35 : 1
    const fire = (this.rpm / 60) * (spec.cyl / 2) * spec.tone // 1 秒あたりの爆発の回数 ≒ 基本の音程
    const r = this.rpm / spec.red
    // 破裂音の列を、1 秒あたりの燃焼の回数に合わせた速さで再生する
    this.set(e.src.playbackRate, fire / PULSE_RATE, 0.02)
    this.set(e.intake.frequency, 500 + r * 1500 + load * 2600, 0.04)
    this.set(e.rasp.frequency, 250 + fire * 2.5, 0.03)
    const shiftDip = this.shiftT > 0 ? 0.45 : 1
    this.set(e.mainGain.gain, (0.07 + load * 0.16 + r * 0.06) * limiter * shiftDip, 0.02)
    this.set(e.subGain.gain, (0.12 + load * 0.12) * shiftDip, 0.03)
    this.set(e.raspGain.gain, (0.01 + load * r * 0.08) * limiter, 0.02)
    // ターボ: 回転と負荷で笛が鳴り、アクセルを急に戻すとブシュッと抜ける
    if (spec.turbo) {
      this.set(e.turbo.frequency, 1800 + this.rpm * 0.55, 0.1)
      this.set(e.turboGain.gain, load * r * 0.012, 0.15)
      if (this.lastThrottle > 0.7 && load < 0.1 && r > 0.5) this.blowOff()
    }
    // アクセルを戻したときのアフターファイア（パン、パパン）
    if (load < 0.05 && r > 0.55 && Math.random() < dt * 9 * r) this.pop()
    this.lastThrottle = load
    void thr
  }

  private clunk(): void {
    const ctx = this.ctx!
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(120, t)
    o.frequency.exponentialRampToValueAtTime(60, t + 0.06)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.06, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
    o.connect(g).connect(this.bus)
    o.start(t)
    o.stop(t + 0.1)
  }

  private burst(buf: AudioBuffer, dest: AudioNode, opts: { gain: number; dur: number; type?: BiquadFilterType; freq: number; to?: number; q?: number; delay?: number; attack?: number; rate?: number }): void {
    const ctx = this.ctx!
    const t = ctx.currentTime + (opts.delay ?? 0)
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.playbackRate.value = opts.rate ?? 1
    const f = ctx.createBiquadFilter()
    f.type = opts.type ?? 'bandpass'
    f.frequency.setValueAtTime(opts.freq, t)
    if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur)
    f.Q.value = opts.q ?? 1
    const g = ctx.createGain()
    const a = opts.attack ?? 0.003
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(opts.gain, t + a)
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur)
    s.connect(f).connect(g).connect(dest)
    s.start(t, Math.random() * (buf.duration - opts.dur - 0.1))
    s.stop(t + opts.dur + 0.05)
  }

  private tone(dest: AudioNode, opts: { freq: number; to?: number; dur: number; gain: number; type?: OscillatorType; delay?: number; attack?: number }): void {
    const ctx = this.ctx!
    const t = ctx.currentTime + (opts.delay ?? 0)
    const o = ctx.createOscillator()
    o.type = opts.type ?? 'sine'
    o.frequency.setValueAtTime(opts.freq, t)
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.004))
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur)
    o.connect(g).connect(dest)
    o.start(t)
    o.stop(t + opts.dur + 0.05)
  }

  private blowOff(): void {
    this.burst(this.white, this.bus, { gain: 0.08, dur: 0.35, type: 'highpass', freq: 3000, to: 1500, q: 0.7 })
  }

  private pop(): void {
    this.burst(this.white, this.bus, { gain: rnd(0.08, 0.2), dur: 0.05, type: 'lowpass', freq: 1400, q: 0.5 })
    this.tone(this.bus, { freq: rnd(70, 110), to: 40, dur: 0.06, gain: 0.15 })
  }

  // --- ほかの車・サイレン -------------------------------------------------------------------

  private makeVoice(siren: boolean): Voice {
    const panner = this.panner(0, 0.8, 0, siren ? 14 : 5, siren ? 0.9 : 1.4)
    const gain = this.gainNode()
    const filter = this.filter('lowpass', siren ? 2200 : 600, siren ? 1 : 0.8)
    const osc = this.osc(siren ? 'sawtooth' : 'sine', siren ? 650 : 20)
    const osc2 = this.osc('square', siren ? 650 : 20)
    let src: AudioBufferSourceNode | null = null
    if (siren) {
      const g2 = this.gainNode(0.4)
      osc.connect(filter)
      osc2.connect(g2).connect(filter)
    } else {
      src = this.loop(this.pulseBuffer(4))
      const boom = this.filter('peaking', 110, 1.2)
      boom.gain.value = 8
      src.connect(boom).connect(filter)
    }
    filter.connect(gain).connect(panner)
    return { src, osc, osc2, filter, gain, panner, id: -1 }
  }

  /** 相手の音程にかけるドップラー効果の倍率 */
  private doppler(v: Vehicle): number {
    const L = this.listener
    const dx = v.body.x - L.x, dz = v.body.z - L.z
    const d = Math.hypot(dx, dz) || 1
    const vs = (v.body.vx * dx + v.body.vz * dz) / d // 遠ざかる向きが正
    const vl = (L.vx * dx + L.vz * dz) / d // 耳が音源へ近づく向きが正
    return clamp((C + vl) / (C + vs), 0.7, 1.4)
  }

  private placeVoice(voice: Voice, v: Vehicle): void {
    const t = this.ctx!.currentTime
    voice.panner.positionX.setTargetAtTime(v.body.x, t, 0.02)
    voice.panner.positionY.setTargetAtTime(1, t, 0.02)
    voice.panner.positionZ.setTargetAtTime(v.body.z, t, 0.02)
  }

  private updateNpcs(vehicles: Vehicle[], me: Vehicle): void {
    const L = this.listener
    const dist = (v: Vehicle) => Math.hypot(v.body.x - L.x, v.body.z - L.z)
    // 近い車 6 台にエンジン音を割り当てる
    const near = vehicles.filter((v) => v !== me && !v.wrecked && dist(v) < 70).sort((a, b) => dist(a) - dist(b)).slice(0, 6)
    while (this.npc.length < 6) this.npc.push(this.makeVoice(false))
    this.npc.forEach((voice, k) => {
      const v = near[k]
      if (!v) { this.set(voice.gain.gain, 0, 0.1); voice.id = -1; return }
      if (voice.id !== v.id) { voice.id = v.id; voice.panner.positionX.value = v.body.x; voice.panner.positionZ.value = v.body.z }
      this.placeVoice(voice, v)
      const sp = speedOf(v.body)
      const rpm = 800 + sp * 110 + (v.controls.throttle > 0 ? 600 : 0)
      const fire = (rpm / 60) * 2 * this.doppler(v)
      if (voice.src) this.set(voice.src.playbackRate, fire / PULSE_RATE)
      this.set(voice.filter.frequency, 300 + sp * 30 + (v.controls.throttle > 0 ? 400 : 0))
      this.set(voice.gain.gain, 0.12 + sp * 0.008, 0.08)
    })
    // サイレン（近い 3 台）。日本のパトカー風の「ウー」とゆっくり上下する音。近いと速い「ピーポー」寄りに
    const sirens = vehicles.filter((v) => v.siren && dist(v) < 450).sort((a, b) => dist(a) - dist(b)).slice(0, 3)
    while (this.sirens.length < 3) this.sirens.push({ ...this.makeVoice(true), phase: Math.random() * 6 })
    this.sirens.forEach((voice, k) => {
      const v = sirens[k]
      if (!v) { this.set(voice.gain.gain, 0, 0.2); voice.id = -1; return }
      if (voice.id !== v.id) { voice.id = v.id; voice.panner.positionX.value = v.body.x; voice.panner.positionZ.value = v.body.z }
      this.placeVoice(voice, v)
      const close = dist(v) < 40
      voice.phase += close ? 0.09 : 0.035
      const sweep = close ? (Math.sin(voice.phase * 3) > 0 ? 1 : 0) : 0.5 - 0.5 * Math.cos(voice.phase)
      const f = (650 + sweep * 680) * this.doppler(v)
      this.set(voice.osc.frequency, f, close ? 0.01 : 0.05)
      this.set(voice.osc2.frequency, f * 1.005, close ? 0.01 : 0.05)
      this.set(voice.gain.gain, 0.09, 0.1)
    })
  }

  // --- 出来事の音 --------------------------------------------------------------------------

  /** 車がぶつかる音。強さ k（0〜1） */
  crash(x: number, z: number, k: number, glass = false): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    if (now - this.lastCrash < 0.07 && k < 0.5) return
    this.lastCrash = now
    const p = this.panner(x, 0.7, z, 10, 0.9)
    // ドスンという低い衝撃（胸に来る低音）
    this.tone(p, { freq: 55 + k * 20, to: 28, dur: 0.35 + k * 0.4, gain: 0.6 + k * 1.2, attack: 0.002 })
    this.burst(this.brown, p, { gain: 0.7 + k * 1.3, dur: 0.25 + k * 0.35, type: 'lowpass', freq: 900, to: 150, q: 0.7, attack: 0.001 })
    // バンッという鋭い当たりの瞬間
    this.burst(this.white, p, { gain: 0.5 + k * 0.9, dur: 0.06, type: 'bandpass', freq: 1800, q: 0.6, attack: 0.0005 })
    // 鉄板がひしゃげて裂ける: 高さの違う短い破裂を、ばらばらの時刻に何十も散らす
    const n = Math.round(8 + k * 30)
    for (let i = 0; i < n; i++) {
      this.burst(this.white, p, {
        gain: (0.08 + k * 0.25) * rnd(0.4, 1), dur: rnd(0.02, 0.09), freq: rnd(500, 4500), q: rnd(3, 14),
        delay: rnd(0, 0.12 + k * 0.35) ** 1.5,
      })
    }
    // 金属の鳴り（板が震える、少し長く残る響き）
    for (const f of [310, 730, 1280, 2150]) {
      this.burst(this.white, p, { gain: (0.05 + k * 0.12) * rnd(0.6, 1), dur: 0.3 + k * 0.6, freq: f * rnd(0.9, 1.1), q: rnd(20, 45), delay: 0.01 })
    }
    // 部品が路面に落ちて転がる
    if (k > 0.35) {
      for (let i = 0; i < 6; i++) {
        this.burst(this.white, p, { gain: rnd(0.04, 0.1), dur: rnd(0.03, 0.08), freq: rnd(1500, 3500), q: rnd(5, 15), delay: rnd(0.2, 0.9) })
      }
    }
    if (glass || k > 0.5) this.glass(p, Math.max(k, 0.7))
  }

  /** ガラスが砕ける「バリン」: 鋭い割れる瞬間と、細かい破片がシャラシャラと散らばる音 */
  private glass(dest: AudioNode, k: number): void {
    this.burst(this.white, dest, { gain: 0.6 * k, dur: 0.08, type: 'highpass', freq: 2500, q: 0.7, attack: 0.0005 })
    this.burst(this.white, dest, { gain: 0.35 * k, dur: 0.45, type: 'highpass', freq: 5000, to: 3000, q: 0.7, delay: 0.01 })
    for (let i = 0; i < 40; i++) {
      this.tone(dest, { freq: rnd(3000, 9500), dur: rnd(0.02, 0.1), gain: rnd(0.02, 0.07) * k, delay: rnd(0.02, 0.8) ** 1.3, type: 'sine' })
    }
    for (let i = 0; i < 14; i++) {
      this.burst(this.white, dest, { gain: rnd(0.03, 0.08) * k, dur: rnd(0.02, 0.05), type: 'highpass', freq: rnd(4000, 7000), q: 1, delay: rnd(0.1, 1.2) })
    }
  }

  /** 人をはねた: 鈍く重い衝撃音 */
  pedHit(x: number, z: number, speed: number): void {
    if (!this.ctx) return
    const p = this.panner(x, 1, z, 7)
    const k = clamp(speed / 20, 0.25, 1)
    this.burst(this.brown, p, { gain: 0.6 + k * 0.8, dur: 0.2, type: 'lowpass', freq: 420, q: 1, attack: 0.001 })
    this.tone(p, { freq: 85, to: 45, dur: 0.18, gain: 0.5 * k })
    this.burst(this.white, p, { gain: 0.12 * k, dur: 0.07, type: 'bandpass', freq: 1300, q: 2, delay: 0.015 })
    // ボンネットがへこむ鈍い金属音
    this.burst(this.white, p, { gain: 0.1 * k, dur: 0.25, freq: 520, q: 18, delay: 0.01 })
  }

  explosion(x: number, z: number): void {
    if (!this.ctx) return
    const p = this.panner(x, 1, z, 30, 0.8)
    // 空気が裂ける音 → 低い地響き → がれきが落ちる音
    this.burst(this.white, p, { gain: 1, dur: 1.8, type: 'lowpass', freq: 5000, to: 160, q: 0.5, attack: 0.002 })
    this.tone(p, { freq: 58, to: 22, dur: 2.2, gain: 1.1, attack: 0.005 })
    this.burst(this.brown, p, { gain: 0.9, dur: 3.2, type: 'lowpass', freq: 400, to: 80, q: 0.5 })
    for (let i = 0; i < 18; i++) {
      this.burst(this.white, p, { gain: rnd(0.02, 0.07), dur: rnd(0.05, 0.15), freq: rnd(1500, 5000), q: rnd(4, 12), delay: rnd(0.4, 2.2) })
    }
    this.glass(p, 1)
  }

  /** 街灯をなぎ倒す（金属の柱がしなって鳴る） */
  clang(x: number, z: number): void {
    if (!this.ctx) return
    const p = this.panner(x, 2, z, 7)
    for (const f of [410, 1080, 1790, 2600]) {
      this.burst(this.white, p, { gain: 0.1, dur: rnd(0.4, 0.9), freq: f, q: 40 })
    }
    this.tone(p, { freq: 90, to: 50, dur: 0.2, gain: 0.3 })
    this.burst(this.brown, p, { gain: 0.3, dur: 0.3, type: 'lowpass', freq: 600, delay: 0.5 }) // 倒れて地面に落ちる
  }

  /** 車を奪った（ドアの開け閉め） */
  carjack(): void {
    if (!this.ctx) return
    this.burst(this.white, this.bus, { gain: 0.12, dur: 0.06, freq: 2400, q: 3 })
    this.tone(this.bus, { freq: 140, to: 70, dur: 0.12, gain: 0.3, delay: 0.5 })
    this.burst(this.brown, this.bus, { gain: 0.4, dur: 0.12, type: 'lowpass', freq: 500, delay: 0.5 })
  }

  /** 海に落ちた: ザブンという大きな水の音と、泡の音 */
  splash(x: number, z: number): void {
    if (!this.ctx) return
    const p = this.panner(x, 0, z, 12)
    this.burst(this.white, p, { gain: 0.9, dur: 1.2, type: 'lowpass', freq: 2500, to: 400, q: 0.5, attack: 0.003 })
    this.burst(this.brown, p, { gain: 0.9, dur: 0.8, type: 'lowpass', freq: 300, q: 0.7 })
    for (let i = 0; i < 30; i++) {
      this.tone(p, { freq: rnd(300, 1400), to: rnd(600, 2200), dur: rnd(0.03, 0.08), gain: rnd(0.02, 0.06), delay: rnd(0.4, 3.5) })
    }
  }

  /** 銃声: 空気を裂く鋭い音と、ビルに反響する音。当たれば車体に金属音 */
  shot(fx: number, fy: number, fz: number, tx: number, tz: number, hit: boolean): void {
    if (!this.ctx) return
    const p = this.panner(fx, fy, fz, 25, 0.8)
    this.burst(this.white, p, { gain: 1.0, dur: 0.09, type: 'highpass', freq: 800, q: 0.6, attack: 0.0003 })
    this.burst(this.brown, p, { gain: 0.7, dur: 0.3, type: 'lowpass', freq: 600, q: 0.6 })
    const t = this.panner(tx, 0.5, tz, 6)
    if (hit) {
      this.burst(this.white, t, { gain: 0.5, dur: 0.12, freq: 2800, q: 6, delay: 0.03 })
      this.burst(this.white, t, { gain: 0.25, dur: 0.4, freq: 1400, q: 30, delay: 0.03 })
    } else {
      // 地面に当たって跳ねる「ピュン」
      this.tone(t, { freq: 2600, to: 900, dur: 0.18, gain: 0.08, delay: 0.03 })
      this.burst(this.white, t, { gain: 0.2, dur: 0.05, freq: 3500, q: 2, delay: 0.03 })
    }
  }

  private updateRotor(h: Heli | null): void {
    const ctx = this.ctx!
    if (!h) {
      if (this.rotor) this.set(this.rotor.gain.gain, 0, 0.5)
      return
    }
    if (!this.rotor) {
      // 羽根が空気をたたく音: ノイズの音量を、羽根が通る回数（1 秒に約 19 回）で揺らす
      const src = this.loop(this.brown, 1)
      const filter = this.filter('lowpass', 700, 0.8)
      const gain = this.gainNode(0)
      const am = this.gainNode(0.5)
      const lfo = this.osc('sawtooth', 19)
      const depth = this.gainNode(0.5)
      lfo.connect(depth).connect(am.gain)
      const panner = this.panner(h.x, h.y, h.z, 30, 0.7)
      src.connect(filter).connect(am).connect(gain).connect(panner)
      // タービンのヒューンという高い音
      const whine = this.osc('sine', 3100)
      const wg = this.gainNode(0.02)
      whine.connect(wg).connect(gain)
      this.rotor = { gain, panner, lfo, filter }
      void ctx
    }
    const t = ctx.currentTime
    this.rotor.panner.positionX.setTargetAtTime(h.x, t, 0.05)
    this.rotor.panner.positionY.setTargetAtTime(h.y, t, 0.05)
    this.rotor.panner.positionZ.setTargetAtTime(h.z, t, 0.05)
    this.set(this.rotor.gain.gain, h.leaving ? 0.6 : 1.4, 0.4)
  }

  /** 車のドアの開け閉め（ガチャ、バタン） */
  door(x: number, z: number): void {
    if (!this.ctx) return
    const p = this.panner(x, 1, z, 5)
    this.burst(this.white, p, { gain: 0.15, dur: 0.05, freq: 2200, q: 4 })
    this.burst(this.brown, p, { gain: 0.5, dur: 0.15, type: 'lowpass', freq: 380, delay: 0.35 })
    this.tone(p, { freq: 120, to: 65, dur: 0.12, gain: 0.3, delay: 0.35 })
  }

  /** 無線の「ザッ」（会話が始まるとき） */
  radio(): void {
    if (!this.ctx) return
    this.burst(this.white, this.bus, { gain: 0.05, dur: 0.12, freq: 2200, q: 1.5 })
    this.tone(this.bus, { freq: 1600, dur: 0.05, gain: 0.02, delay: 0.1, type: 'square' })
  }

  /** 音楽的な合図（ミッション開始・成功・失敗・手配度・逮捕・死亡） */
  cue(kind: 'start' | 'success' | 'fail' | 'star' | 'lost' | 'busted' | 'wasted' | 'chapter'): void {
    if (!this.ctx) return
    const n = (s: number) => 440 * 2 ** (s / 12)
    const chord = (notes: number[], dur: number, gap: number, type: OscillatorType = 'triangle', gain = 0.05) =>
      notes.forEach((s, i) => this.tone(this.bus, { freq: n(s), dur, gain, type, delay: i * gap, attack: 0.02 }))
    switch (kind) {
      case 'start': chord([-5, 0, 4, 7], 0.5, 0.08); break
      case 'success': chord([0, 4, 7, 12, 16], 0.7, 0.09, 'triangle', 0.06); chord([12, 16, 19], 1.2, 0, 'sine', 0.03); break
      case 'chapter': chord([-12, -5, 0, 4, 7, 12, 16, 19], 1.5, 0.12, 'triangle', 0.05); break
      case 'fail': chord([0, -3, -7, -12], 0.6, 0.14, 'sawtooth', 0.03); break
      case 'star': this.tone(this.bus, { freq: 880, to: 1320, dur: 0.18, gain: 0.05, type: 'square' }); break
      case 'lost': chord([7, 4, 0], 0.4, 0.1); break
      case 'busted':
      case 'wasted':
        chord([-24, -17, -12, -9], 3, 0.25, 'sawtooth', 0.04)
        this.burst(this.brown, this.bus, { gain: 0.4, dur: 2.5, type: 'lowpass', freq: 300, to: 60 })
        break
    }
  }

  onEvents(events: GameEvent[], me: Vehicle): void {
    for (const e of events) {
      switch (e.kind) {
        case 'crash': this.crash(e.x, e.z, clamp(e.impact / 16, 0.12, 1), e.impact > 11); break
        case 'door': this.door(e.x, e.z); break
        case 'splash': this.splash(e.x, e.z); break
        case 'shot': this.shot(e.fx, e.fy, e.fz, e.tx, e.tz, e.hit); break
        case 'pedHit': this.pedHit(e.x, e.z, e.speed); break
        case 'propBreak': this.clang(e.x, e.z); break
        case 'explosion': this.explosion(e.x, e.z); break
        case 'carjack': this.carjack(); break
        case 'stars': this.cue(e.up ? 'star' : 'lost'); break
        case 'busted': this.cue('busted'); break
        case 'wasted': this.cue('wasted'); break
        case 'missionStart': this.cue('start'); break
        case 'missionEnd': this.cue(e.ok ? 'success' : 'fail'); break
        case 'story': if (e.chapterDone) this.cue('chapter'); break
        case 'dialogue': this.radio(); break
      }
    }
    void me
  }

  // --- 毎フレーム --------------------------------------------------------------------------

  /** cam は耳の位置と向き（カメラ）。me は自分の車 */
  update(dt: number, cam: { x: number; y: number; z: number; fx: number; fy: number; fz: number },
         me: Vehicle, vehicles: Vehicle[], night: number, panic: number, heli: Heli | null = null): void {
    if (!this.ctx) return
    this.time += dt
    const ctx = this.ctx
    const L = ctx.listener
    const t = ctx.currentTime
    this.listener.vx = (cam.x - this.listener.x) / Math.max(dt, 1e-3)
    this.listener.vz = (cam.z - this.listener.z) / Math.max(dt, 1e-3)
    this.listener.x = cam.x; this.listener.y = cam.y; this.listener.z = cam.z
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.x, t, 0.01)
      L.positionY.setTargetAtTime(cam.y, t, 0.01)
      L.positionZ.setTargetAtTime(cam.z, t, 0.01)
      L.forwardX.setTargetAtTime(cam.fx, t, 0.01)
      L.forwardY.setTargetAtTime(cam.fy, t, 0.01)
      L.forwardZ.setTargetAtTime(cam.fz, t, 0.01)
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0
    }

    this.updateEngine(me, dt)
    const b = me.body
    const sp = speedOf(b)
    // タイヤ・路面・風
    const squeal = clamp((b.slip - 3.5) / 9, 0, 1) * (sp > 2 ? 1 : 0)
    this.set(this.tire.gain.gain, squeal * 0.22, 0.03)
    this.set(this.tire.toneGain.gain, squeal * 0.03, 0.03)
    this.set(this.tire.filter.frequency, 1100 + b.slip * 50, 0.05)
    this.set(this.tire.tone.frequency, 900 + b.slip * 30 + Math.sin(this.time * 3) * 40, 0.05)
    this.set(this.road.filter.frequency, 120 + sp * 14, 0.1)
    this.set(this.road.gain.gain, Math.min(sp / 30, 1) * 0.16, 0.1)
    this.set(this.wind.filter.frequency, 500 + sp * 30, 0.1)
    this.set(this.wind.gain.gain, (sp / 60) ** 2 * 0.25, 0.1)
    this.set(this.horn.gain.gain, me.honking ? 0.07 : 0, 0.015)

    this.updateNpcs(vehicles, me)
    this.updateRotor(heli)

    // 環境音: 夜は車の流れが減る。雨の街はずっと雨音
    this.set(this.amb.traffic.gain, 0.035 + (1 - night) * 0.04, 0.5)
    this.set(this.amb.trafficF.frequency, 160 + Math.sin(this.time * 0.13) * 60, 0.5)
    this.nextBird -= dt
    if (this.nextBird < 0) {
      this.nextBird = rnd(1.5, 5)
      const x = cam.x + rnd(-40, 40), z = cam.z + rnd(-40, 40)
      if (night < 0.4 && this.theme !== 'snow') this.bird(x, z)
      else if (night > 0.6 && this.theme !== 'snow' && this.theme !== 'metro') this.crickets(x, z)
      if (this.theme === 'bay' && Math.random() < 0.3) this.gull(x, z)
    }
    this.nextDistant -= dt
    if (this.nextDistant < 0) {
      this.nextDistant = rnd(6, 16)
      const a = Math.random() * Math.PI * 2
      const x = cam.x + Math.sin(a) * 250, z = cam.z + Math.cos(a) * 250
      if (Math.random() < 0.5) this.distantHorn(x, z)
      else this.distantSiren(x, z)
    }
    void panic
  }

  private bird(x: number, z: number): void {
    const p = this.panner(x, 8, z, 10)
    const base = rnd(2600, 4200)
    const n = Math.floor(rnd(2, 6))
    for (let i = 0; i < n; i++) {
      this.tone(p, { freq: base * rnd(0.9, 1.1), to: base * rnd(1.2, 1.6), dur: rnd(0.05, 0.12), gain: 0.025, delay: i * rnd(0.09, 0.16) })
    }
  }

  private crickets(x: number, z: number): void {
    const p = this.panner(x, 0.3, z, 6)
    const f = rnd(4200, 5200)
    for (let i = 0; i < 12; i++) this.tone(p, { freq: f, dur: 0.025, gain: 0.02, delay: i * 0.045 + (i >= 6 ? 0.25 : 0), type: 'triangle' })
  }

  private gull(x: number, z: number): void {
    const p = this.panner(x, 15, z, 15)
    for (let i = 0; i < 3; i++) {
      this.tone(p, { freq: 1500, to: 900, dur: 0.25, gain: 0.03, delay: i * 0.3, type: 'sawtooth' })
    }
  }

  private distantHorn(x: number, z: number): void {
    const p = this.panner(x, 1, z, 20)
    for (const f of [415, 523]) this.tone(p, { freq: f, dur: rnd(0.3, 0.8), gain: 0.05, type: 'square' })
  }

  private distantSiren(x: number, z: number): void {
    const ctx = this.ctx!
    const p = this.panner(x, 2, z, 30)
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    const t = ctx.currentTime
    for (let i = 0; i < 4; i++) {
      o.frequency.setValueAtTime(650, t + i * 2.4)
      o.frequency.linearRampToValueAtTime(1300, t + i * 2.4 + 1.2)
      o.frequency.linearRampToValueAtTime(650, t + i * 2.4 + 2.4)
    }
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1500
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.04, t + 1.5)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 9.5)
    o.connect(lp).connect(g).connect(p)
    o.start(t)
    o.stop(t + 9.6)
  }

  stop(): void {
    for (const n of this.nodes) { try { n.stop() } catch { /* 止め済み */ } }
    this.nodes = []
    try { this.bus?.disconnect() } catch { /* 切り離し済み */ }
    this.started = false
    this.eng = null
    this.ctx = null
  }
}
