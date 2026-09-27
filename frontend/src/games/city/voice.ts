// VOICEVOX で作ったセリフの音声（public/city/voice/）を読み込んで鳴らす。
// 作り方は scripts/city-voices.ts。ファイル名は sim/voiceLines.ts の voiceKey()。
//
//   位置あり  その場所（パトカー・野次馬・はねられた人）から 3D で聞こえる
//   位置なし  無線や会話。耳元で聞こえる。（無線）のセリフはトランシーバーのようなざらついた音にする

import { sound } from '../../lib/sound'
import type { Line } from './sim/story'
import { isRadio, voiceKey } from './sim/voiceLines'

const BASE = `${import.meta.env.BASE_URL}city/voice/`
let index: Record<string, string> | null = null
let indexLoading: Promise<void> | null = null
const buffers = new Map<string, Promise<AudioBuffer | null>>()

function loadIndex(): Promise<void> {
  if (!indexLoading) {
    indexLoading = fetch(`${BASE}index.json`).then((r) => (r.ok ? r.json() : {})).then((j) => { index = j }).catch(() => { index = {} })
  }
  return indexLoading
}

function buffer(ctx: AudioContext, key: string): Promise<AudioBuffer | null> {
  let b = buffers.get(key)
  if (!b) {
    b = fetch(`${BASE}${key}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((a) => ctx.decodeAudioData(a)).catch(() => null)
    buffers.set(key, b)
  }
  return b
}

export interface VoiceOptions {
  /** 聞こえてくる場所（無ければ耳元） */
  at?: { x: number; z: number; y?: number }
  /** つなぐ先（残響のある音の通り道など）。無ければ全体の音量につなぐ */
  dest?: AudioNode
  /** 再生速度（声の高さも少し変わる。人ごとに少しずつ変えると同じ声に聞こえにくい） */
  rate?: number
  gain?: number
}

/** 音声があるか（読み込み済みの一覧で調べる） */
export async function hasVoice(line: Line): Promise<boolean> {
  await loadIndex()
  return !!index?.[voiceKey(line)]
}

/** 前もって読み込んでおく（しゃべり始めの遅れを減らす） */
export function preloadVoices(lines: Line[]): void {
  const o = sound.output()
  if (!o) return
  void loadIndex().then(() => { for (const l of lines) if (index?.[voiceKey(l)]) void buffer(o.ctx, voiceKey(l)) })
}

/**
 * セリフを鳴らす。鳴らし終わったら true、音声が無い・鳴らせないなら false で解決する
 */
export async function playVoice(line: Line, opt: VoiceOptions = {}): Promise<boolean> {
  const o = sound.output()
  if (!o || sound.settings.muted) return false
  await loadIndex()
  const key = voiceKey(line)
  if (!index?.[key]) return false
  const buf = await buffer(o.ctx, key)
  if (!buf) return false
  const ctx = o.ctx
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = opt.rate ?? 1
  const g = ctx.createGain()
  g.gain.value = opt.gain ?? 1
  let node: AudioNode = src
  if (!opt.at && isRadio(line)) {
    // 無線: 低音と高音を削り、少し歪ませ、ザーという雑音を重ねる
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2800
    const ws = ctx.createWaveShaper()
    const curve = new Float32Array(256)
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.5) }
    ws.curve = curve
    node.connect(hp).connect(lp).connect(ws)
    node = ws
    const n = ctx.createBufferSource()
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = nb.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.04
    n.buffer = nb
    n.loop = true
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1800
    n.connect(nf).connect(g)
    n.start()
    src.addEventListener('ended', () => n.stop())
  }
  if (opt.at) {
    const p = ctx.createPanner()
    p.panningModel = 'HRTF'
    p.distanceModel = 'inverse'
    p.refDistance = 4
    p.rolloffFactor = 1.1
    p.positionX.value = opt.at.x
    p.positionY.value = opt.at.y ?? 1.6
    p.positionZ.value = opt.at.z
    node.connect(g).connect(p).connect(opt.dest ?? o.out)
  } else {
    node.connect(g).connect(opt.dest ?? o.out)
  }
  src.start()
  return new Promise((resolve) => src.addEventListener('ended', () => resolve(true)))
}
