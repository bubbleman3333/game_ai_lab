// 物語の画面。1 行ずつ文字送りで出し、クリック・Enter・Space で次へ。
// 後ろには 3D の森（ForestBackdrop）が見えていて、行の bg で背景が切り替わる（TypingPage が決める）。
//
// 臨場感のための演出（どれも chapters.ts の StoryLine に書く）:
//   sfx   行が出た瞬間に効果音（ひぐらし・障子・心臓の音・ささやき・地鳴り…）
//   fx    画面が揺れる（shake）/ 白く光る（flash）/ 暗くなる（dark）
//   kind  'scene' 場面の見出しは真ん中に大きく、'voice' 影の声は文字が震える
//   文字送りは「、」「。」「……」で少し間を置く（読む速さに緩急をつける）
//
// 文字送りの位置は「どの行の」位置かと一緒に持ち、行が変わったら 0 から数え直す（背景は作り直さない）。
// 1 行進むごとに onLine を呼ぶ（呼び出し側がセーブする）ので、途中で閉じても続きから読める。

import { useCallback, useEffect, useState } from 'react'
import type { Chapter, StoryLine } from '../sim/chapters'
import { storySfx, typingSounds } from '../sounds'

interface Props {
  chapter: Chapter
  part: 'intro' | 'outro'
  lines: StoryLine[]
  /** 何行目から読むか（セーブの位置） */
  line: number
  accent: string
  onLine: (line: number) => void
  onDone: () => void
}

/** 1 文字を出す間隔（ミリ秒） */
const CHAR_MS = 40

/** 直前の文字によって、次の文字までの間を延ばす（読点・句点・三点リーダー） */
function pauseAfter(ch: string | undefined): number {
  if (!ch) return 0
  if ('。！？'.includes(ch)) return 260
  if (ch === '…') return 90
  if ('、」'.includes(ch)) return 110
  return 0
}

export function StoryView({ chapter, part, lines, line, accent, onLine, onDone }: Props) {
  const lineKey = `${chapter.id}-${part}-${line}`
  const [typing, setTyping] = useState({ key: lineKey, shown: 0 })
  const shown = typing.key === lineKey ? typing.shown : 0
  const setShown = useCallback((n: number) => setTyping({ key: lineKey, shown: n }), [lineKey])
  const cur = lines[Math.min(line, lines.length - 1)]
  const full = cur?.text ?? ''
  const finished = shown >= full.length

  // 行が出た瞬間の効果音（仲間になった行はファンファーレも）
  useEffect(() => {
    if (!cur) return
    if (cur.sfx) storySfx[cur.sfx]()
    if (cur.kind === 'reward') typingSounds.clear()
  }, [cur, lineKey])

  useEffect(() => {
    if (finished) return
    // 場面の見出しはゆっくり、影の声は少し遅く
    const base = cur?.kind === 'scene' ? 90 : cur?.kind === 'voice' ? 70 : CHAR_MS
    const t = setTimeout(() => setShown(shown + 1), base + pauseAfter(full[shown - 1]))
    return () => clearTimeout(t)
  }, [shown, finished, setShown, full, cur])

  const next = useCallback(() => {
    if (!finished) {
      setShown(full.length)
      return
    }
    typingSounds.page()
    if (line + 1 < lines.length) onLine(line + 1)
    else onDone()
  }, [finished, full.length, line, lines.length, onLine, onDone, setShown])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next])

  if (!cur) return null
  // 章の題名は最初の行だけ大きく出し、あとは左上に小さく
  const opening = line === 0
  const lastIntro = part === 'intro' && line === lines.length - 1
  return (
    <div className="typing-story" style={{ ['--typing-accent' as string]: accent }} onClick={next}>
      <div className="typing-story-sky" />
      {cur.fx && <div key={lineKey} className={`typing-story-fx ${cur.fx}`} aria-hidden />}
      <div className="typing-story-fireflies" aria-hidden>
        {Array.from({ length: 18 }, (_, i) => <span key={i} style={{ left: `${(i * 53) % 100}%`, animationDelay: `${(i * 0.7) % 6}s` }} />)}
      </div>
      {opening ? (
        <header className="typing-story-head">
          <span className="typing-story-num">{chapter.number}</span>
          <span className="typing-story-title">{chapter.title}</span>
          <span className="typing-story-part">{part === 'intro' ? chapter.hour : '― その後 ―'}</span>
        </header>
      ) : (
        <div className="typing-story-corner">
          {chapter.number}「{chapter.title}」<span>{part === 'intro' ? chapter.hour : 'その後'}</span>
        </div>
      )}
      {lastIntro && <div className="typing-story-goal">目的: {chapter.goal}</div>}
      <div key={cur.fx === 'shake' ? lineKey : undefined}
           className={`typing-story-box${cur.kind ? ` ${cur.kind}` : ''}${cur.fx === 'shake' ? ' shake' : ''}`}>
        {cur.who && <div className="typing-story-who">{cur.who}</div>}
        <p className="typing-story-text">
          {full.slice(0, shown)}
          {finished && <span className="typing-story-caret">▼</span>}
        </p>
        <div className="typing-story-foot">
          <span className="muted small">{line + 1} / {lines.length}　クリック・Enter で次へ（自動で保存されます）</span>
          <button type="button" className="ghost small" onClick={(e) => { e.stopPropagation(); onDone() }}>
            飛ばす
          </button>
        </div>
      </div>
    </div>
  )
}
