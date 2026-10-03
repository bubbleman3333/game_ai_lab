// canvas を 1 枚置いて 3D の森（scene/ForestScene.ts）を動かし、その上に影の言葉の札（HTML）を重ねる。
//
// 毎フレームやること:
//   1. 経過時間を測ってゲームを進める（sim/game.ts）
//   2. 出来事に合わせて音と演出を出す
//   3. 森を描き、影の頭の上に言葉の札を動かす（札は React を通さず DOM を直接動かす。毎フレーム作り直すと重いため）
//   4. HUD に出す値を、React に 20 回/秒だけ渡す
//
// キー入力もここで受ける。
//   英字・数字・記号 → game.key()   Backspace → 狙いを外す   Esc → 一時停止（onPause）
//   日本語入力（IME）がオンのままだとキーが届かないので、気づいたら onIme で知らせる。

import { useEffect, useRef, useState } from 'react'
import type { GameEvent, TypingGame } from '../sim/game'
import { ForestScene } from '../scene/ForestScene'
import { ForestAmbience, typingSounds } from '../sounds'

/** HUD に出すための、その瞬間の値 */
export interface Snapshot {
  oil: number
  score: number
  combo: number
  multiplier: number
  wave: number
  totalWaves: number
  boss: { name: string; left: number; total: number } | null
  result: 'clear' | 'dead' | null
  time: number
  kpm: number
  accuracy: number
}

export function snapshotOf(game: TypingGame): Snapshot {
  const b = game.boss
  return {
    oil: game.oil, score: game.score, combo: game.combo, multiplier: game.multiplier,
    wave: game.waveIndex, totalWaves: game.totalWaves,
    boss: b && b.phrases ? { name: game.chapter.boss?.name ?? '', left: b.phrases.length - (b.phraseIndex ?? 0), total: b.phrases.length } : null,
    result: game.result, time: game.time, kpm: game.kpm, accuracy: game.accuracy,
  }
}

interface Props {
  game: TypingGame
  paused: boolean
  onSnapshot: (s: Snapshot) => void
  onEvents: (e: GameEvent[]) => void
  onPause: () => void
  onIme: () => void
  /** スマホのキーボード用の見えない入力欄（ここに打たれた文字も拾う） */
  inputRef: React.RefObject<HTMLInputElement | null>
}

const HUD_INTERVAL = 0.05

function playEvent(ev: GameEvent): void {
  switch (ev.kind) {
    case 'key': return typingSounds.key(ev.combo)
    case 'miss': return typingSounds.miss()
    case 'lock': return typingSounds.lock()
    case 'kill': return ev.score > 0 || ev.enemy === 'boss' ? typingSounds.kill(ev.enemy === 'boss') : undefined
    case 'hit': return typingSounds.hit(ev.damage)
    case 'heal': return typingSounds.heal()
    case 'wave': return typingSounds.wave()
    case 'boss': return typingSounds.boss()
    case 'boss-hurt': return typingSounds.bossHurt()
    case 'clear': return typingSounds.clear()
    case 'dead': return typingSounds.dead()
  }
}

interface Label {
  el: HTMLDivElement
  text: HTMLDivElement
  kana: HTMLDivElement
  typed: HTMLSpanElement
  rest: HTMLSpanElement
  key: string
}

function makeLabel(parent: HTMLElement, boss: boolean): Label {
  const el = document.createElement('div')
  el.className = boss ? 'typing-label boss' : 'typing-label'
  const text = document.createElement('div')
  text.className = 'typing-label-text'
  const kana = document.createElement('div')
  kana.className = 'typing-label-kana'
  const roma = document.createElement('div')
  roma.className = 'typing-label-roma'
  const typed = document.createElement('span')
  typed.className = 'typed'
  const rest = document.createElement('span')
  roma.append(typed, rest)
  el.append(text, kana, roma)
  parent.append(el)
  return { el, text, kana, typed, rest, key: '' }
}

export function ForestCanvas({ game, paused, onSnapshot, onEvents, onPause, onIme, inputRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const cb = useRef({ onSnapshot, onEvents, onPause, onIme })
  const pausedRef = useRef(paused)
  useEffect(() => {
    cb.current = { onSnapshot, onEvents, onPause, onIme }
    pausedRef.current = paused
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const labelLayer = labelsRef.current
    if (!canvas || !labelLayer) return
    let scene: ForestScene
    try {
      scene = new ForestScene(canvas, game.chapter.id)
    } catch (e) {
      // WebGL が使えない環境（古いブラウザ・リモートデスクトップなど）
      console.error(e)
      setFailed(true)
      return
    }
    const resize = () => scene.resize()
    window.addEventListener('resize', resize)
    resize()
    // デバッグ用: コンソールから window.__typing で進行を見られる（例: __typing.enemies, __typing.oil = 5）
    ;(window as unknown as { __typing?: TypingGame }).__typing = game

    const ambience = new ForestAmbience()
    ambience.start()

    const emit = (events: GameEvent[]) => {
      if (!events.length) return
      for (const ev of events) playEvent(ev)
      scene.handleEvents(events, game)
      cb.current.onEvents(events)
    }

    // --- キー入力 ---
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === 'Process') {
        cb.current.onIme()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cb.current.onPause()
        return
      }
      if (pausedRef.current || game.over || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        emit(game.release())
        return
      }
      if (e.key.length === 1) {
        e.preventDefault() // 見えない入力欄に文字が入らないように（入ると二重に数えてしまう）
        if (/[ぁ-んァ-ヶ]/.test(e.key)) {
          cb.current.onIme()
          return
        }
        emit(game.key(e.key))
      }
    }
    // スマホのキーボードは keydown で文字が取れないことがあるので、入力欄に入った文字を拾う
    const input = inputRef.current
    const onInput = () => {
      if (!input) return
      const v = input.value
      input.value = ''
      if (pausedRef.current || game.over) return
      if (/[ぁ-んァ-ヶ]/.test(v)) {
        cb.current.onIme()
        return
      }
      for (const ch of v) emit(game.key(ch))
    }
    window.addEventListener('keydown', onKeyDown)
    input?.addEventListener('input', onInput)

    // --- 言葉の札 ---
    const labels = new Map<number, Label>()
    const updateLabels = () => {
      const w = labelLayer.clientWidth, h = labelLayer.clientHeight
      const alive = new Set<number>()
      for (const e of game.enemies) {
        alive.add(e.id)
        let l = labels.get(e.id)
        if (!l) {
          l = makeLabel(labelLayer, e.kind === 'boss')
          labels.set(e.id, l)
        }
        const pos = scene.labelPosition(e, w, h)
        if (!pos) {
          l.el.style.display = 'none'
          continue
        }
        const visible = game.isVisible(e)
        const key = `${visible}|${e.word.text}|${e.matcher.typed}`
        if (key !== l.key) {
          l.key = key
          l.text.textContent = visible ? e.word.text : '？？？'
          l.kana.textContent = visible && e.word.text !== e.word.kana ? e.word.kana : ''
          l.typed.textContent = visible ? e.matcher.typed : ''
          l.rest.textContent = visible ? e.matcher.rest : ''
        }
        // 遠いほど小さく。ボスの札は画面の幅に収まる大きさに固定
        const scale = e.kind === 'boss' ? 1 : Math.max(0.62, Math.min(1.15, 1.25 - e.z / 34))
        const locked = game.target === e
        l.el.style.display = ''
        l.el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%) scale(${scale})`
        l.el.style.zIndex = locked ? '1000' : String(Math.round(100 - e.z))
        l.el.classList.toggle('locked', locked)
        l.el.classList.toggle('near', e.z < 7 && e.kind !== 'boss')
        l.el.classList.toggle('fox', e.kind === 'fox')
        l.el.classList.toggle('hidden-word', !visible)
      }
      for (const [id, l] of labels) {
        if (!alive.has(id)) {
          l.el.remove()
          labels.delete(id)
        }
      }
    }

    let raf = 0
    let last = performance.now()
    let hudTimer = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (!pausedRef.current) emit(game.update(dt))
      const nearest = game.enemies.reduce((m, e) => Math.min(m, e.z), 30)
      ambience.update(dt, game.over ? 0 : Math.max(game.boss ? 0.6 : 0, 1 - nearest / 30))
      scene.update(pausedRef.current ? 0 : dt, game)
      updateLabels()
      hudTimer += dt
      if (hudTimer >= HUD_INTERVAL) {
        hudTimer = 0
        cb.current.onSnapshot(snapshotOf(game))
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      input?.removeEventListener('input', onInput)
      for (const l of labels.values()) l.el.remove()
      ambience.stop()
      scene.dispose()
    }
  }, [game, inputRef])

  if (failed) {
    return (
      <p className="page error">
        3D を表示できませんでした。このブラウザで WebGL が使えるか確かめてください
        （リモートデスクトップや古いブラウザでは使えないことがあります）。
      </p>
    )
  }
  return (
    <>
      <canvas ref={canvasRef} className="typing-canvas" />
      <div ref={labelsRef} className="typing-labels" />
    </>
  )
}

