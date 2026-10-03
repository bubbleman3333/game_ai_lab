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
import { GameMusic } from '../music'
import { ForestAmbience, typingSounds } from '../sounds'

/** HUD に出すための、その瞬間の値 */
export interface Snapshot {
  oil: number
  maxOil: number
  /** 残りの鈴の回数（鈴を持っていなければ null） */
  bells: number | null
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
  /** 闇の残り（秒）・お手本が消えている残り（秒） */
  darkness: number
  guideHidden: number
  /** ボスが溜めている攻撃 */
  bossCharging: string | null
  /** 目の前に吸い付いている影の数 */
  latched: number
}

export function snapshotOf(game: TypingGame): Snapshot {
  const b = game.boss
  return {
    oil: game.oil, maxOil: game.perks.maxOil, bells: game.perks.bell ? game.bells : null, score: game.score, combo: game.combo, multiplier: game.multiplier,
    wave: game.waveIndex, totalWaves: game.totalWaves,
    boss: b && b.phrases ? { name: game.chapter.boss?.name ?? '', left: b.phrases.length - (b.phraseIndex ?? 0), total: b.phrases.length } : null,
    result: game.result, time: game.time, kpm: game.kpm, accuracy: game.accuracy,
    darkness: game.darkness, guideHidden: game.guideHidden, bossCharging: game.bossCharging,
    latched: game.enemies.filter((e) => e.state === 'latched').length,
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
    case 'bell': return typingSounds.bell()
    case 'shoot': return typingSounds.shoot()
    case 'ink': return typingSounds.ink()
    case 'howl': return typingSounds.howl()
    case 'latch': return typingSounds.latch()
    case 'drain': return typingSounds.drain()
    case 'call': return typingSounds.call()
    case 'mimic': return typingSounds.mimic()
    case 'boss-charge': return typingSounds.charge()
    case 'boss-attack': return ev.attack === 'quake' ? typingSounds.quake() : undefined
    case 'windup': return typingSounds.windup()
    case 'golden': return typingSounds.golden()
    case 'fragment': return typingSounds.fragment()
    case 'escape': return typingSounds.escape()
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

interface Bar {
  el: HTMLDivElement
  text: HTMLDivElement
  typed: HTMLSpanElement
  next: HTMLSpanElement
  rest: HTMLSpanElement
  key: string
}

function makeBar(parent: HTMLElement): Bar {
  const el = document.createElement('div')
  el.className = 'typing-bar empty'
  const text = document.createElement('div')
  text.className = 'typing-bar-text'
  const roma = document.createElement('div')
  roma.className = 'typing-bar-roma'
  const typed = document.createElement('span')
  typed.className = 'typed'
  const next = document.createElement('span')
  next.className = 'next'
  const rest = document.createElement('span')
  roma.append(typed, next, rest)
  el.append(text, roma)
  parent.append(el)
  return { el, text, typed, next, rest, key: '' }
}

/** CSS のアニメーションを、もう一度最初から流す（同じクラスを付け直しても再生されないため） */
function pop(el: HTMLElement, cls: string): void {
  el.classList.remove('typing-bar-pop', 'typing-bar-miss')
  void el.offsetWidth // ここで一度描き直させると、次に付けたクラスのアニメーションが最初から流れる
  el.classList.add(cls)
}

/** 倒した言葉の文字が 1 字ずつ光になって昇っていく（CSS のアニメーション。終わったら消す） */
function dissolve(parent: HTMLElement, l: Label): void {
  const el = document.createElement('div')
  el.className = l.el.classList.contains('boss') ? 'typing-dissolve boss' : 'typing-dissolve'
  el.style.transform = l.el.style.transform
  ;[...(l.text.textContent ?? '')].forEach((ch, i) => {
    const span = document.createElement('span')
    span.textContent = ch
    span.style.setProperty('--i', String(i))
    span.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`)
    el.append(span)
  })
  parent.append(el)
  setTimeout(() => el.remove(), 1600)
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
    // BGM: 最初の波で道中の曲を鳴らし、ボスが出たらボスの曲へ。言葉を返すほど盛り上げ、終わったら止める
    let music: GameMusic | null = null
    let bossMusic = false
    const stopMusic = () => {
      music?.stop()
      music = null
    }

    const emit = (events: GameEvent[]) => {
      if (!events.length) return
      for (const ev of events) {
        playEvent(ev)
        if (ev.kind === 'key') {
          scene.kick(0.12)
          pop(bar.el, 'typing-bar-pop')
        } else if (ev.kind === 'miss') {
          pop(bar.el, 'typing-bar-miss')
        }
        if (ev.kind === 'wave' && !music && !game.over) {
          music = new GameMusic()
          music.start()
        } else if (ev.kind === 'boss') {
          if (!music) {
            music = new GameMusic()
            music.start()
          }
          bossMusic = true
          music.toBoss()
        } else if (ev.kind === 'boss-hurt' && music) {
          const total = game.chapter.boss?.phrases.length ?? 1
          music.setIntensity((total - ev.left) / Math.max(1, total - 1))
        } else if ((ev.kind === 'kill' && ev.enemy === 'boss') || ev.kind === 'clear' || ev.kind === 'dead') {
          stopMusic()
        }
      }
      scene.handleEvents(events)
      for (const ev of events) if (ev.kind === 'kill') killed.add(ev.id)
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
      if (e.key === ' ') {
        e.preventDefault()
        emit(game.ringBell())
        return
      }
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

    // --- 画面下の「今打っている言葉」（大きく出す。狙っていないときは、いちばん近い影の言葉をうすく） ---
    const bar = makeBar(labelLayer.parentElement ?? labelLayer)
    const updateBar = () => {
      const t = game.target ?? [...game.enemies].filter((e) => game.isVisible(e)).sort((a, b) => a.z - b.z)[0]
      const noGuide = game.guideHidden > 0
      const key = t ? `${t.id}|${t.word.text}|${t.matcher.typed}|${game.target === t}|${noGuide}` : ''
      if (key === bar.key) return
      bar.key = key
      bar.el.classList.toggle('empty', !t)
      bar.el.classList.toggle('idle', !!t && game.target !== t)
      bar.text.textContent = t ? t.word.text : ''
      bar.typed.textContent = t ? t.matcher.typed : ''
      const rest = t ? t.matcher.rest : ''
      // 咆哮のあいだ: ローマ字のお手本は消え、かなだけが見える（読みから打つ）
      bar.el.classList.toggle('noguide', noGuide)
      bar.next.textContent = noGuide ? '' : rest.slice(0, 1)
      bar.rest.textContent = noGuide ? `（${t && t.word.kana !== t.word.text ? t.word.kana : 'かな'}を見て打て）` : rest.slice(1)
    }

    // --- 言葉の札 ---
    const labels = new Map<number, Label>()
    /** 倒された影の id。札を消すとき、文字が光になって昇る演出を出す */
    const killed = new Set<number>()
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
        const noGuide = game.guideHidden > 0
        const key = `${e.word.text}|${e.matcher.typed}|${noGuide}`
        if (key !== l.key) {
          l.key = key
          l.text.textContent = e.word.text
          // お手本が消えているあいだは、かなを必ず出す（読みから打てるように）
          l.kana.textContent = e.word.text !== e.word.kana || noGuide ? e.word.kana : ''
          l.typed.textContent = e.matcher.typed
          l.rest.textContent = noGuide ? '・'.repeat(Math.min(8, e.matcher.rest.length)) : e.matcher.rest
        }
        // 霧の章: 遠いほど文字がぼやける（読めないほどではない。待たせないため、すぐ打てる）
        const fog = game.chapter.reveal > 0 && e.kind !== 'boss'
          ? Math.max(0, Math.min(1, (e.z - 12) / 16)) * (game.perks.revealBonus > 0 ? 0.6 : 1) : 0
        l.el.style.filter = fog > 0.05 ? `blur(${(fog * 3).toFixed(1)}px)` : ''
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
        l.el.classList.toggle('danger', e.state === 'windup' || e.state === 'dash')
        l.el.classList.toggle('armored', e.behavior === 'tank' && e.hp > 1)
        l.el.classList.toggle('orb', e.kind === 'orb')
        l.el.classList.toggle('golden', e.behavior === 'golden')
        l.el.classList.toggle('latched', e.state === 'latched')
        l.el.classList.toggle('aiming', e.state === 'aim')
        l.el.classList.toggle('charging', e.kind === 'boss' && game.bossCharging !== null)
        l.el.classList.toggle('in-dark', game.darkness > 0 && !visible)
      }
      for (const [id, l] of labels) {
        if (!alive.has(id)) {
          if (killed.has(id) && l.el.style.display !== 'none') dissolve(labelLayer, l)
          killed.delete(id)
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
      // 道中の曲は、影が近いほど・多いほど激しくなる（ボスの曲は言葉を返した数で決める）
      if (music && !bossMusic) music.setIntensity(Math.max(1 - nearest / 22, (game.enemies.length - 1) / 4))
      scene.update(pausedRef.current ? 0 : dt, game)
      if (scene.stepTaken() && !pausedRef.current) typingSounds.step()
      updateLabels()
      updateBar()
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
      bar.el.remove()
      ambience.stop()
      stopMusic()
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

