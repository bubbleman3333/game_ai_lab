// 会話の読み上げ。字幕と同時にしゃべらせる。
//
// まず VOICEVOX で作った音声（voice.ts、public/city/voice/）を探して鳴らす。
// 無いセリフ（あとから足して、まだ音声を作っていないもの）だけ、ブラウザ（OS）の音声合成で読む。
//
// Windows の Edge なら「Microsoft Nanami / Keita (Natural)」のような自然な声、Chrome なら「Google 日本語」や
// 「Microsoft Haruka / Ichiro」などが使える。どの声があるかは環境しだいなので、名前から男女を推測して
// 登場人物ごとに声を割り当て、高さと速さで演じ分ける。日本語の声が無い環境では何もしない（字幕だけ）。
//
// 音量は画面右上の音量設定に合わせる（ミュートならしゃべらない）。

import { sound } from '../../lib/sound'
import type { Line } from './sim/story'
import { playVoice } from './voice'

const FEMALE = /nanami|haruka|ayumi|sayaka|kyoko|mayu|aoi|shiori|google|mizuki|female|女性/i
const MALE = /keita|ichiro|otoya|daichi|naoki|takumi|kenji|male|男性/i

/** 登場人物の声: 男女・声の高さ・話す速さ */
const CAST: Record<string, { male: boolean; pitch: number; rate: number }> = {
  レン: { male: true, pitch: 0.92, rate: 1.05 },
  ミオ: { male: false, pitch: 1.12, rate: 1.1 },
  カミヤ: { male: true, pitch: 0.7, rate: 0.92 },
  ハヤト: { male: true, pitch: 1.05, rate: 1.15 },
  サエキ: { male: true, pitch: 0.82, rate: 1.0 },
  警察官: { male: true, pitch: 0.95, rate: 1.05 },
  無線: { male: false, pitch: 1, rate: 1.1 },
}

let voices: SpeechSynthesisVoice[] = []
function loadVoices(): void {
  if (typeof speechSynthesis === 'undefined') return
  voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ja'))
  // 自然な声（Natural / Online / Neural）を優先する
  voices.sort((a, b) => score(b) - score(a))
}
const score = (v: SpeechSynthesisVoice) => (/natural|neural|online/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1)
if (typeof speechSynthesis !== 'undefined') {
  loadVoices()
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices)
}

function voiceFor(male: boolean): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const re = male ? MALE : FEMALE
  return voices.find((v) => re.test(v.name)) ?? voices[0]
}

/** 声に出すときは（）の中のト書きを取る */
const spoken = (text: string) => text.replace(/（[^）]*）/g, '').replace(/[　 ]+/g, ' ').trim()

/**
 * 1 行しゃべる。しゃべり終わったら（または声が無ければ、読むのにかかる時間がたったら）解決する
 */
export async function speak(line: Line): Promise<void> {
  if (await playVoice(line)) {
    await new Promise((r) => window.setTimeout(r, 300)) // 次の人がしゃべるまでの間
    return
  }
  return speakTts(line)
}

function speakTts(line: Line): Promise<void> {
  const fallback = 1800 + line.text.length * 110
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = window.setTimeout(done, fallback + 4000)
    const text = spoken(line.text)
    const cast = CAST[line.who] ?? CAST.無線
    const muted = sound.settings.muted || sound.settings.volume <= 0
    if (typeof speechSynthesis === 'undefined' || !text || muted || line.who === '無線') {
      clearTimeout(timer)
      window.setTimeout(resolve, fallback)
      return
    }
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ja-JP'
    const v = voiceFor(cast.male)
    if (v) u.voice = v
    // 男性の声が見つからず女性の声で代用するときは、低めにして演じ分ける
    const substituted = v && cast.male && !MALE.test(v.name)
    u.pitch = Math.max(0.1, cast.pitch * (substituted ? 0.72 : 1))
    u.rate = cast.rate
    u.volume = Math.min(1, sound.settings.volume * 1.4)
    u.onend = () => window.setTimeout(done, 250)
    u.onerror = () => window.setTimeout(done, fallback)
    speechSynthesis.speak(u)
  })
}

/** しゃべっている途中の声を止める（画面を閉じたとき） */
export function stopSpeech(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}
