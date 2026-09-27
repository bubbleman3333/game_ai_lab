// /city。タイトル画面（物語を続ける・章を選ぶ・街を選んで自由に走る・車と画質）と、走る画面。
//
// 物語の進み具合と最高記録はブラウザに保存する（localStorage）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CityCanvas, type Snapshot } from '../components/CityCanvas'
import { CityHud, type Toast } from '../components/CityHud'
import { CityTouch } from '../components/CityTouch'
import { Minimap } from '../components/Minimap'
import { CityInput } from '../input'
import { speak, stopSpeech } from '../speech'
import type { Quality } from '../scene/CityScene'
import { THEMES } from '../scene/themes'
import { Game, type GameEvent } from '../sim/game'
import { MAPS, mapById } from '../sim/maps'
import { CHAPTERS, mapUnlocked, storyDone, type Line, type StoryProgress } from '../sim/story'
import { SPECS, type VehicleType } from '../sim/vehicle'

const SAVE_KEY = 'game-ai-lab:city'

interface Save { progress: StoryProgress; best: number; car: VehicleType; quality: Quality }
const DEFAULT_SAVE: Save = { progress: { chapter: 0, step: 0 }, best: 0, car: 'sport', quality: 'high' }

function load(): Save {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    return raw ? { ...DEFAULT_SAVE, ...JSON.parse(raw) } : DEFAULT_SAVE
  } catch {
    return DEFAULT_SAVE
  }
}
function store(s: Save): void {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)) } catch { /* 保存できなくても遊べる */ }
}

const CARS: VehicleType[] = ['sport', 'sedan', 'suv', 'hatch', 'van', 'taxi']
const CAR_COLORS: Record<VehicleType, number> = {
  sport: 0xc81e2a, sedan: 0x1f2f55, suv: 0x2d4a3a, hatch: 0xd8d2c4, van: 0xe9e9ea, taxi: 0xf2b705, police: 0xffffff,
}

interface Run { mapId: string; progress: StoryProgress; key: number }

export function CityPage() {
  const [save, setSave] = useState<Save>(load)
  const [run, setRun] = useState<Run | null>(null)
  const update = useCallback((patch: Partial<Save>) => {
    setSave((s) => { const n = { ...s, ...patch }; store(n); return n })
  }, [])

  if (run) {
    return (
      <CityPlay key={run.key} run={run} save={save} update={update}
                onQuit={() => setRun(null)}
                onNext={(p) => setRun({ mapId: CHAPTERS[p.chapter]?.map ?? run.mapId, progress: p, key: Date.now() })} />
    )
  }

  const p = save.progress
  const ch = CHAPTERS[p.chapter]
  const start = (mapId: string, progress = save.progress) => setRun({ mapId, progress, key: Date.now() })
  return (
    <div className="page city-menu">
      <h1>GETAWAY <small>― 逃がし屋 ―</small></h1>
      <p className="muted">
        4 つの街を車で駆ける 3D オープンワールド。通行人・一般車・警察が動き回り、昼も夜も雨も雪もある。
        物語を進めると次の街へ行ける。
      </p>

      <section className="city-story">
        <h2>物語</h2>
        {!storyDone(p) ? (
          <>
            <p><b>{ch.title}</b>　舞台: {mapById(ch.map).name}（{p.step} / {ch.steps.length} 済み）</p>
            <button type="button" className="primary city-go" onClick={() => start(ch.map)}>
              {p.chapter === 0 && p.step === 0 ? '物語をはじめる' : '続きから'}
            </button>
          </>
        ) : (
          <p>物語はすべて終わりました。どの街も自由に走れます。</p>
        )}
        {p.chapter > 0 && (
          <details>
            <summary>章を選び直す</summary>
            <div className="city-chapters">
              {CHAPTERS.slice(0, Math.min(p.chapter + 1, CHAPTERS.length)).map((c, i) => (
                <button type="button" key={c.title}
                        onClick={() => { const np = { chapter: i, step: 0 }; update({ progress: np }); start(c.map, np) }}>
                  {c.title}
                </button>
              ))}
            </div>
          </details>
        )}
      </section>

      <section>
        <h2>街を選んで自由に走る</h2>
        <div className="city-maps">
          {MAPS.map((m) => {
            const open = mapUnlocked(p, m.id)
            return (
              <button type="button" key={m.id} className="city-map-card" disabled={!open}
                      style={{ '--city-accent': THEMES[m.theme].accent } as React.CSSProperties}
                      onClick={() => start(m.id)}>
                <span className="city-map-name">{open ? m.name : '🔒 ' + m.name}</span>
                <span className="muted">{m.blocks * 94}m 四方 · {m.blocks}×{m.blocks} 区画</span>
                <span>{open ? m.description : '物語を進めると行けるようになる'}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="city-options">
        <h2>車と画質</h2>
        <div className="city-cars">
          {CARS.map((c) => (
            <button type="button" key={c} className={save.car === c ? 'on' : ''} onClick={() => update({ car: c })}>
              {SPECS[c].name}
            </button>
          ))}
        </div>
        <label>
          画質{' '}
          <select value={save.quality} onChange={(e) => update({ quality: e.target.value as Quality })}>
            <option value="high">高い（影・光のにじみあり）</option>
            <option value="low">軽い（古い PC・スマホ向け）</option>
          </select>
        </label>
        <p className="muted">最高所持金: ${save.best.toLocaleString()}</p>
      </section>

      <section>
        <h2>操作</h2>
        <ul className="city-keys">
          <li><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd> アクセル・ブレーキ（止まるとバック）</li>
          <li><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> ハンドル　<kbd>Space</kbd> サイドブレーキ（ドリフト）</li>
          <li><kbd>H</kbd> クラクション（人が逃げる）　<kbd>F</kbd> 近くの車を奪う（止まっているとき）</li>
          <li><kbd>C</kbd> カメラ切り替え　<kbd>Q</kbd> 後ろを見る　マウスでドラッグ: 見回す</li>
          <li><kbd>M</kbd> 地図　<kbd>T</kbd> 時間を 1 時間進める　<kbd>R</kbd> 道路に戻る　<kbd>Esc</kbd> 一時停止</li>
        </ul>
        <p className="muted">
          人をはねたり、パトカーにぶつけたりすると手配度（★）が上がり、警察が追ってくる。
          見つからないまま逃げ続けると手配が解ける。止まったまま囲まれると逮捕、車が壊れると WASTED。
        </p>
      </section>
      <p><Link to="/">← ゲーム一覧へ</Link></p>
    </div>
  )
}

interface PlayProps {
  run: Run
  save: Save
  update: (p: Partial<Save>) => void
  onQuit: () => void
  onNext: (p: StoryProgress) => void
}

function CityPlay({ run, save, update, onQuit, onNext }: PlayProps) {
  const config = mapById(run.mapId)
  const game = useMemo(() => new Game(config, run.progress, save.car, CAR_COLORS[save.car]),
    // 走り始めるときに 1 回だけ作る
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run.key])
  const input = useMemo(() => new CityInput(), [])
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [paused, setPaused] = useState(false)
  const [bigMap, setBigMap] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [banner, setBanner] = useState<{ title: string; sub: string } | null>(null)
  const [line, setLine] = useState<Line | null>(null)
  const [chapterDone, setChapterDone] = useState<StoryProgress | null>(null)
  const queue = useRef<Line[]>([])
  const toastId = useRef(0)
  const bestRef = useRef(save.best)

  const toast = useCallback((text: string, kind: Toast['kind']) => {
    const id = ++toastId.current
    setToasts((t) => [...t.slice(-4), { id, text, kind }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])

  const showBanner = useCallback((title: string, sub: string) => {
    setBanner({ title, sub })
    window.setTimeout(() => setBanner((b) => (b?.title === title ? null : b)), 3200)
  }, [])

  // 字幕: 1 行ずつ、長さに合わせた時間だけ出す
  useEffect(() => {
    if (line || queue.current.length === 0) return
    const next = queue.current.shift()!
    setLine(next)
  }, [line, toasts, snap])
  // しゃべり終わったら次の行へ（声が無い環境では、読むのにかかる時間で進む）
  useEffect(() => {
    if (!line) return
    let alive = true
    void speak(line).then(() => { if (alive) setLine(null) })
    return () => { alive = false }
  }, [line])
  useEffect(() => () => stopSpeech(), [])

  // 章の始まり
  useEffect(() => {
    const ch = CHAPTERS[run.progress.chapter]
    if (ch && ch.map === config.id && run.progress.step === 0) showBanner(ch.title, config.name)
    else showBanner(config.name, config.description)
    queue.current.push(...game.chapterIntro())
  }, [game, config, run.progress, showBanner])

  const onEvents = useCallback((events: GameEvent[]) => {
    for (const e of events) {
      switch (e.kind) {
        case 'score': toast(`${e.amount >= 0 ? '+' : ''}$${e.amount} ${e.text}`, e.amount >= 0 ? 'score' : 'bad'); break
        case 'stars': if (!e.up && e.stars === 0) toast('手配が解けた', 'good'); break
        case 'carjack': toast(`${e.name} を奪った`, 'info'); break
        case 'missionStart': showBanner(e.title, e.story ? '物語' : 'ミッション'); break
        case 'missionEnd': showBanner(e.ok ? 'ミッション成功' : 'ミッション失敗', e.text); break
        case 'dialogue': queue.current.push(...e.lines); break
        case 'story':
          update({ progress: e.progress })
          if (e.chapterDone) setChapterDone(e.progress)
          break
      }
    }
    if (game.score > bestRef.current) { bestRef.current = game.score; update({ best: game.score }) }
  }, [game, toast, showBanner, update])

  const nextCh = chapterDone ? CHAPTERS[chapterDone.chapter] : null
  const accent = THEMES[config.theme].accent
  return (
    <div className="city-play" style={{ '--city-accent': accent } as React.CSSProperties}>
      <CityCanvas game={game} input={input} quality={save.quality} paused={paused || bigMap || (chapterDone !== null && !line)}
                  onSnapshot={setSnap} onEvents={onEvents}
                  onPause={() => setPaused((p) => !p)} onToggleMap={() => setBigMap((b) => !b)} />
      <CityHud game={game} snap={snap} line={line} toasts={toasts} banner={banner} />
      <CityTouch input={input} />
      <button type="button" className="city-pause-btn" onClick={() => setPaused(true)}>Ⅱ</button>
      {bigMap && (
        <div className="city-overlay" onClick={() => setBigMap(false)}>
          <Minimap game={game} big />
          <p className="muted">★ 黄色 = 物語 / 青 = 配達・チェックポイント / 赤 = 暴走 / 紫 = 逃走 / 橙 = 標的　（M で閉じる）</p>
        </div>
      )}
      {paused && !chapterDone && (
        <div className="city-overlay">
          <div className="city-pause card">
            <h2>一時停止</h2>
            <p className="muted">{config.name}　所持金 ${game.score.toLocaleString()}　はねた人 {game.stats.pedsHit}　壊した車 {game.stats.carsWrecked}</p>
            <div className="city-pause-actions">
              <button type="button" className="primary" onClick={() => setPaused(false)}>続ける</button>
              <button type="button" onClick={onQuit}>タイトルへ</button>
            </div>
          </div>
        </div>
      )}
      {chapterDone && !line && queue.current.length === 0 && (
        <div className="city-overlay">
          <div className="city-pause card">
            <h2>{CHAPTERS[chapterDone.chapter - 1].title} クリア</h2>
            {nextCh ? (
              <>
                <p>次の舞台は <b>{mapById(nextCh.map).name}</b>。</p>
                <div className="city-pause-actions">
                  <button type="button" className="primary" onClick={() => onNext(chapterDone)}>{nextCh.title} へ</button>
                  <button type="button" onClick={() => setChapterDone(null)}>この街で走り続ける</button>
                </div>
              </>
            ) : (
              <>
                <p>物語はここまで。おつかれさまでした。</p>
                <div className="city-pause-actions">
                  <button type="button" className="primary" onClick={() => setChapterDone(null)}>走り続ける</button>
                  <button type="button" onClick={onQuit}>タイトルへ</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
