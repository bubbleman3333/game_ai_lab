// シティのセリフを VOICEVOX で音声にする。
//
// 使い方（VOICEVOX を起動しておく。エンジンは http://127.0.0.1:50021 で待っている）:
//   cd frontend; node scripts/city-voices.ts
//
// src/games/city/sim/voiceLines.ts の全セリフを読み、まだ音声が無いものだけ作る。
// 出力: public/city/voice/<key>.mp3 と、一覧 public/city/voice/index.json（key → 話し手）
// mp3 への変換に ffmpeg を使う（PATH に入っていること）。
//
// 声の割り当ては SPEAKERS。クレジットは画面（タイトル画面の下）と README に書くこと。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allVoiceLines, spokenText, voiceKey } from '../src/games/city/sim/voiceLines.ts'

const ENGINE = process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021'
const OUT = join(import.meta.dirname, '..', 'public', 'city', 'voice')

/** 登場人物 → VOICEVOX の声（style id）と、話す速さ・抑揚・声の高さ */
const SPEAKERS: Record<string, { id: number; name: string; speed?: number; intonation?: number; pitch?: number }> = {
  レン: { id: 11, name: '玄野武宏', speed: 1.05, intonation: 1.05 },
  ミオ: { id: 14, name: '冥鳴ひまり', speed: 1.08 },
  カミヤ: { id: 53, name: '麒ヶ島宗麟', speed: 0.95, pitch: -0.03 },
  ハヤト: { id: 12, name: '白上虎太郎', speed: 1.12, intonation: 1.2 },
  サエキ: { id: 52, name: '雀松朱司', speed: 1.0 },
  警察官: { id: 21, name: '剣崎雌雄', speed: 1.08, intonation: 1.25 },
  野次馬A: { id: 8, name: '春日部つむぎ', speed: 1.1, intonation: 1.3 },
  野次馬B: { id: 16, name: '九州そら', speed: 1.1 },
  野次馬C: { id: 23, name: 'WhiteCUL', speed: 1.1, intonation: 1.2 },
  野次馬D: { id: 55, name: '猫使アル', speed: 1.1 },
  // 悲鳴・叫び（感情の強いスタイルを使う）
  通行人女1: { id: 8, name: '春日部つむぎ', speed: 1.05, intonation: 1.6, pitch: 0.04 },
  通行人女2: { id: 26, name: 'WhiteCUL', speed: 1.05, intonation: 1.5 },
  通行人男1: { id: 33, name: '白上虎太郎', speed: 1.05, intonation: 1.5 },
  通行人男2: { id: 35, name: '白上虎太郎', speed: 1.0, intonation: 1.4, pitch: -0.05 },
}

async function synth(text: string, sp: (typeof SPEAKERS)[string]): Promise<Buffer> {
  const q = await fetch(`${ENGINE}/audio_query?text=${encodeURIComponent(text)}&speaker=${sp.id}`, { method: 'POST' })
  if (!q.ok) throw new Error(`audio_query ${q.status}`)
  const query = await q.json()
  query.speedScale = sp.speed ?? 1
  query.intonationScale = sp.intonation ?? 1.1
  query.pitchScale = sp.pitch ?? 0
  query.prePhonemeLength = 0.05
  query.postPhonemeLength = 0.12
  query.outputSamplingRate = 24000
  const w = await fetch(`${ENGINE}/synthesis?speaker=${sp.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
  })
  if (!w.ok) throw new Error(`synthesis ${w.status}`)
  return Buffer.from(await w.arrayBuffer())
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const indexPath = join(OUT, 'index.json')
  const index: Record<string, string> = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf-8')) : {}
  const lines = allVoiceLines()
  let made = 0
  for (const line of lines) {
    const key = voiceKey(line)
    const mp3 = join(OUT, `${key}.mp3`)
    const sp = SPEAKERS[line.who]
    if (!sp) { console.warn(`声が決まっていない: ${line.who}`); continue }
    if (existsSync(mp3)) { index[key] = line.who; continue }
    const text = spokenText(line.text)
    if (!text) continue
    const wav = join(OUT, `${key}.wav`)
    writeFileSync(wav, await synth(text, sp))
    // 小さくするため mp3（モノラル 56kbps）にする
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-b:a', '56k', mp3])
    unlinkSync(wav)
    index[key] = line.who
    made++
    console.log(`${line.who}: ${text}`)
  }
  // もう使っていない音声は一覧から外す（ファイルは残る）
  const keep = new Set(lines.map(voiceKey))
  for (const k of Object.keys(index)) if (!keep.has(k)) delete index[k]
  writeFileSync(indexPath, JSON.stringify(index, null, 0))
  const credits = [...new Set(lines.map((l) => SPEAKERS[l.who]?.name).filter(Boolean))].map((n) => `VOICEVOX:${n}`)
  console.log(`\n${made} 本つくった（全 ${lines.length} 本）。クレジット: ${credits.join(' / ')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
