// 物語の画面。1 行ずつ文字送りで出し、クリック・Enter・Space で次へ。
// 文字送りの位置は「どの行の」位置かと一緒に持ち、行が変わったら 0 から数え直す（背景は作り直さない）。
// 1 行進むごとに onLine を呼ぶ（呼び出し側がセーブする）ので、途中で閉じても続きから読める。

import { useCallback, useEffect, useState } from 'react'
import type { Chapter, StoryLine } from '../sim/chapters'
import { typingSounds } from '../sounds'

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
const CHAR_MS = 38

export function StoryView({ chapter, part, lines, line, accent, onLine, onDone }: Props) {
  const lineKey = `${chapter.id}-${part}-${line}`
  const [typing, setTyping] = useState({ key: lineKey, shown: 0 })
  const shown = typing.key === lineKey ? typing.shown : 0
  const setShown = useCallback((n: number) => setTyping({ key: lineKey, shown: n }), [lineKey])
  const cur = lines[Math.min(line, lines.length - 1)]
  const full = cur?.text ?? ''
  const finished = shown >= full.length

  useEffect(() => {
    if (finished) return
    const t = setTimeout(() => setShown(shown + 1), CHAR_MS)
    return () => clearTimeout(t)
  }, [shown, finished, setShown])

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
  return (
    <div className="typing-story" style={{ ['--typing-accent' as string]: accent }} onClick={next}>
      <div className="typing-story-sky" />
      <div className="typing-story-fireflies" aria-hidden>
        {Array.from({ length: 18 }, (_, i) => <span key={i} style={{ left: `${(i * 53) % 100}%`, animationDelay: `${(i * 0.7) % 6}s` }} />)}
      </div>
      <header className="typing-story-head">
        <span className="typing-story-num">{chapter.number}</span>
        <span className="typing-story-title">{chapter.title}</span>
        <span className="typing-story-part">{part === 'intro' ? '' : '― その後 ―'}</span>
      </header>
      <div className="typing-story-box">
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
