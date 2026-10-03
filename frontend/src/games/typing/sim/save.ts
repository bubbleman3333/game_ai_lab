// セーブデータ。スロットは 3 つ。ブラウザ（localStorage）に自動で保存し、
// ファイルへの書き出し・読み込みもできる（別のブラウザや PC へ持っていくため）。
//
// 物語の位置は「今の章」「その章のどこ（はじめの話 / 戦い / 終わりの話）」「何行目」で持つ。
// 1 行読むごとに保存するので、ブラウザを閉じても読みかけの行から続けられる。
//
// 形を変えたら SAVE_VERSION を上げ、migrate() で古い形を読めるようにする（遊んでいる人のセーブを消さないため）。

import { type AllyId, CHAPTERS, type Chapter, ENDLESS } from './chapters'
import { type Difficulty, NO_PERKS, type Perks } from './game'

export const SAVE_VERSION = 1
export const SLOT_COUNT = 3
const KEY = (slot: number) => `game-ai-lab:typing:slot:${slot}`

export type Part = 'intro' | 'play' | 'outro'
export type Rank = 'S' | 'A' | 'B' | 'C'

export interface Best {
  score: number
  rank: Rank
  kpm: number
  accuracy: number
}

export interface SaveData {
  version: number
  /** 物語の今の章（CHAPTERS の番号）。CHAPTERS.length なら物語は終わっている */
  chapter: number
  part: Part
  /** 物語の何行目まで読んだか */
  line: number
  /** クリアした章の id */
  cleared: string[]
  /** 章ごと・難しさごとの自己ベスト。キーは `${章の id}:${難しさ}` */
  best: Record<string, Best>
  difficulty: Difficulty
  /** 遊んだ時間（秒。戦っていた時間の合計） */
  playTime: number
  createdAt: number
  updatedAt: number
}

export function newSave(difficulty: Difficulty = 'normal'): SaveData {
  const now = Date.now()
  return {
    version: SAVE_VERSION, chapter: 0, part: 'intro', line: 0, cleared: [], best: {},
    difficulty, playTime: 0, createdAt: now, updatedAt: now,
  }
}

/** 物語を最後まで読んだか（「終わらない夜」が遊べる） */
export function storyFinished(s: SaveData): boolean {
  return s.chapter >= CHAPTERS.length
}

/** 今の章（物語が終わっていれば null） */
export function currentChapter(s: SaveData): Chapter | null {
  return CHAPTERS[s.chapter] ?? null
}

/** 助け出した仲間（クリアした章で助けた者）。物語の順に並ぶ */
export function alliesOf(s: SaveData): AllyId[] {
  return CHAPTERS.filter((c) => c.rescue && s.cleared.includes(c.id)).map((c) => c.rescue!)
}

/** 仲間がくれる力。遊び直しの章でも、今いる仲間の力を使える */
export function perksOf(s: SaveData): Perks {
  const allies = alliesOf(s)
  return {
    maxOil: NO_PERKS.maxOil + (allies.includes('ruri') ? 1 : 0),
    healCombo: allies.includes('mio') ? 20 : NO_PERKS.healCombo,
    revealBonus: allies.includes('kuro') ? 6 : 0,
    bell: allies.includes('bell'),
  }
}

/** 遊び直せる章（クリアした章と、今の章）。終わらない夜は物語を終えてから */
export function playableChapters(s: SaveData): Chapter[] {
  const list = CHAPTERS.filter((c, i) => s.cleared.includes(c.id) || i === s.chapter)
  return storyFinished(s) ? [...list, ENDLESS] : list
}

/** 物語を 1 行進める。その部分を読み終えたら次の部分へ */
export function advanceLine(s: SaveData): SaveData {
  const ch = currentChapter(s)
  if (!ch || s.part === 'play') return s
  const lines = s.part === 'intro' ? ch.intro : ch.outro
  if (s.line + 1 < lines.length) return touch({ ...s, line: s.line + 1 })
  return finishPart(s)
}

/** 今読んでいる話を飛ばす（最後まで読んだことにする） */
export function finishPart(s: SaveData): SaveData {
  if (s.part === 'intro') return touch({ ...s, part: 'play', line: 0 })
  if (s.part === 'outro') return touch({ ...s, chapter: s.chapter + 1, part: 'intro', line: 0 })
  return s
}

/** 戦いの結果を記録する。物語の今の章をクリアしたら、終わりの話へ進む */
export function recordResult(s: SaveData, chapterId: string, difficulty: Difficulty, cleared: boolean,
                             result: Best, seconds: number): SaveData {
  const key = `${chapterId}:${difficulty}`
  const prev = s.best[key]
  // 終わらない夜は「力尽きるまで」でクリアが無いので、力尽きたときの点も記録に残す
  const counts = cleared || chapterId === ENDLESS.id
  const best = counts && (!prev || result.score > prev.score) ? { ...s.best, [key]: result } : s.best
  let next: SaveData = { ...s, best, playTime: s.playTime + seconds }
  if (cleared && !next.cleared.includes(chapterId)) next = { ...next, cleared: [...next.cleared, chapterId] }
  const cur = currentChapter(s)
  if (cleared && cur?.id === chapterId && s.part === 'play') next = { ...next, part: 'outro', line: 0 }
  return touch(next)
}

function touch(s: SaveData): SaveData {
  return { ...s, updatedAt: Date.now() }
}

// ------------------------------------------------------------------ 読み書き

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadSlot(slot: number): SaveData | null {
  try {
    const raw = storage()?.getItem(KEY(slot))
    return raw ? parseSave(raw) : null
  } catch {
    return null
  }
}

export function loadSlots(): (SaveData | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => loadSlot(i))
}

/** 保存する。保存できなかったら false（プライベートブラウズなど） */
export function writeSlot(slot: number, s: SaveData): boolean {
  try {
    const st = storage()
    if (!st) return false
    st.setItem(KEY(slot), JSON.stringify(s))
    return true
  } catch {
    return false
  }
}

export function deleteSlot(slot: number): void {
  try {
    storage()?.removeItem(KEY(slot))
  } catch {
    /* 消せなくても困らない */
  }
}

/** ファイルに書き出す文字列 */
export function exportSave(s: SaveData): string {
  return JSON.stringify({ game: 'himori-typing', ...s }, null, 2)
}

/** 読み込んだ文字列をセーブデータにする。形がおかしければ例外（画面でそのまま伝える） */
export function parseSave(text: string): SaveData {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('セーブデータとして読めませんでした（JSON ではありません）')
  }
  if (!raw || typeof raw !== 'object') throw new Error('セーブデータの形ではありません')
  return migrate(raw as Record<string, unknown>)
}

function migrate(r: Record<string, unknown>): SaveData {
  const base = newSave()
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  if (typeof r.chapter !== 'number' || !Array.isArray(r.cleared)) throw new Error('セーブデータに必要な項目がありません')
  const part: Part = r.part === 'play' || r.part === 'outro' ? r.part : 'intro'
  const difficulty: Difficulty = r.difficulty === 'easy' || r.difficulty === 'hard' ? r.difficulty : 'normal'
  return {
    version: SAVE_VERSION,
    chapter: Math.max(0, Math.min(CHAPTERS.length, Math.floor(r.chapter))),
    part,
    line: Math.max(0, Math.floor(num(r.line, 0))),
    cleared: (r.cleared as unknown[]).filter((x): x is string => typeof x === 'string'),
    best: r.best && typeof r.best === 'object' ? (r.best as Record<string, Best>) : {},
    difficulty,
    playTime: num(r.playTime, 0),
    createdAt: num(r.createdAt, base.createdAt),
    updatedAt: num(r.updatedAt, base.updatedAt),
  }
}
