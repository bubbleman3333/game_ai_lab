// レースの画面 `/racer`。コースと車と相手を選んで走る。
//
// 3D の重い部分（three.js）は scene/ にまとまっていて、このページはその外側
// （選択画面・HUD・結果の保存）だけを持つ。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { fetchAgents, fetchPolicy, saveResult, type RacerAgentDto } from '../api/racer'
import { RaceCanvas, type Snapshot } from '../components/RaceCanvas'
import { RaceHud } from '../components/RaceHud'
import { RaceTouch } from '../components/RaceTouch'
import * as CO from '../engine/course'
import * as P from '../engine/physics'
import { Policy } from '../engine/policy'
import { RaceInput } from '../game/input'
import { formatTime, Race, type RaceEvent, type RacerSpec } from '../game/race'
import { themeFor } from '../scene/themes'

const AI_COLORS = [0x3ad1a0, 0xe8c341, 0xb066e8]
const BEST_KEY = (course: string, car: string) => `racer.best.${course}.${car}`

const EMPTY: Snapshot = {
  speed: 0, lap: 1, laps: 3, place: 1, total: 1, time: -3.2,
  lapTimes: [], bestLap: null, boost: 0, airborne: false, finished: false,
}

type Opponent = 'none' | 'heuristic' | string // string は AI の ID

export function RacerPage() {
  const [courseId, setCourseId] = useState(CO.COURSE_DEFS[0].id)
  const [carId, setCarId] = useState(P.CARS[0].id)
  const [opponent, setOpponent] = useState<Opponent>('none')
  const [agents, setAgents] = useState<RacerAgentDto[]>([])
  const [race, setRace] = useState<Race | null>(null)
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [best, setBest] = useState<number | null>(null)
  const savedRef = useRef(false)
  const input = useMemo(() => new RaceInput(), [])

  const course = CO.load(courseId)
  const theme = themeFor(course.theme)

  useEffect(() => {
    fetchAgents().then(setAgents).catch(() => setAgents([]))
  }, [])

  useEffect(() => input.attach(), [input])

  useEffect(() => {
    const raw = localStorage.getItem(BEST_KEY(courseId, carId))
    setBest(raw ? Number(raw) : null)
  }, [courseId, carId])

  // レース中は画面を暗い背景にする（3D が映えるように）
  useEffect(() => {
    document.body.classList.toggle('racer-playing', race !== null)
    return () => document.body.classList.remove('racer-playing')
  }, [race])

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const specs: RacerSpec[] = [{ name: 'あなた', kind: 'human', carId }]
      if (opponent === 'heuristic') {
        specs.push({ name: '学習なし AI', kind: 'heuristic', carId, skill: 1, color: AI_COLORS[0] })
      } else if (opponent !== 'none') {
        const json = await fetchPolicy(opponent)
        const policy = new Policy(json)
        specs.push({ name: opponent, kind: 'ai', carId, policy, color: AI_COLORS[0] })
        specs.push({ name: '学習なし AI', kind: 'heuristic', carId, skill: 0.92, color: AI_COLORS[1] })
      }
      savedRef.current = false
      setSnap({ ...EMPTY, laps: course.laps, total: specs.length })
      setRace(new Race(courseId, specs))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '相手の AI を読み込めませんでした')
    } finally {
      setBusy(false)
    }
  }, [carId, courseId, course.laps, opponent])

  const quit = useCallback(() => {
    setRace(null)
    input.clear()
  }, [input])

  const readInput = useCallback((dt: number) => input.read(dt), [input])

  const onEvents = useCallback((events: RaceEvent[]) => {
    for (const ev of events) {
      if (!race || ev.who !== race.racers.indexOf(race.player)) continue
      if (ev.kind === 'trick') setFlash(`トリック +${ev.value}`)
      else if (ev.kind === 'fall') setFlash('コースに戻ります')
      else if (ev.kind === 'lap') setFlash(`ラップ ${ev.value}`)
    }
  }, [race])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1300)
    return () => clearTimeout(t)
  }, [flash])

  // ゴールしたら、タイムを保存する
  useEffect(() => {
    if (!race || !snap.finished || savedRef.current) return
    savedRef.current = true
    const me = race.player
    const lap = race.bestLap(me)
    if (lap !== null && (best === null || lap < best)) {
      localStorage.setItem(BEST_KEY(courseId, carId), String(lap))
      setBest(lap)
    }
    saveResult({
      course: courseId, car: carId,
      agent: opponent === 'none' ? 'なし' : opponent,
      laps: race.laps,
      total_sec: me.finishedAt ?? 0,
      best_lap_sec: lap ?? 0,
      tricks: me.tricks, falls: me.falls,
      place: race.racers.length > 1 ? race.place(me) : null,
      racers: race.racers.length,
    }).catch(() => undefined)
  }, [race, snap.finished, best, courseId, carId, opponent])

  if (race) {
    const me = race.player
    return (
      <div className="racer-play" style={{ ['--racer-accent' as string]: theme.accent }}>
        <RaceCanvas race={race} readInput={readInput} onSnapshot={setSnap} onEvents={onEvents} />
        <RaceHud snap={snap} race={race} flash={flash} />
        <RaceTouch input={input} />
        <button type="button" className="racer-quit" onClick={quit}>やめる</button>
        {snap.finished && (
          <div className="racer-result card">
            <h2>ゴール</h2>
            <p className="mono racer-result-time">{formatTime(me.finishedAt)}</p>
            <dl className="racer-result-list">
              <div><dt>ベストラップ</dt><dd className="mono">{formatTime(race.bestLap(me))}</dd></div>
              {race.racers.length > 1 && <div><dt>順位</dt><dd>{race.place(me)} / {race.racers.length}</dd></div>}
              <div><dt>トリック</dt><dd>{me.tricks} 回</dd></div>
              <div><dt>落ちた回数</dt><dd>{me.falls} 回</dd></div>
              {me.lapTimes.map((t, i) => (
                <div key={i}><dt>ラップ {i + 1}</dt><dd className="mono">{formatTime(t)}</dd></div>
              ))}
            </dl>
            <div className="racer-result-actions">
              <button type="button" onClick={start}>もう一度</button>
              <button type="button" className="ghost" onClick={quit}>コースを選び直す</button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page">
      <h1>レース</h1>
      <p className="muted">
        3D のレースゲーム。坂をのぼりきったところやジャンプ台で宙に浮き、空中で回してから着地すると
        ブーストがもらえます。操作は <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> または矢印キー、
        <kbd>Space</kbd> でジャンプ。
      </p>

      <section className="card">
        <h2>コース</h2>
        <div className="racer-picker">
          {CO.COURSE_DEFS.map((d) => {
            const c = CO.load(d.id)
            const t = themeFor(c.theme)
            return (
              <button
                key={d.id}
                type="button"
                className={`racer-card ${courseId === d.id ? 'on' : ''}`}
                style={{ ['--racer-accent' as string]: t.accent }}
                onClick={() => setCourseId(d.id)}
              >
                <CourseMap id={d.id} />
                <span className="racer-card-title">{c.name}</span>
                <span className="muted">{c.description}</span>
                <span className="muted small">
                  1 周 {Math.round(c.length)}m ・ {c.laps} 周
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="card">
        <h2>車</h2>
        <div className="racer-picker">
          {P.CARS.map((car) => (
            <button
              key={car.id}
              type="button"
              className={`racer-card ${carId === car.id ? 'on' : ''}`}
              onClick={() => setCarId(car.id)}
            >
              <span className="racer-card-title">{car.name}</span>
              <span className="muted">{car.description}</span>
              <CarBars car={car} />
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>相手</h2>
        <div className="racer-options">
          <label>
            <input type="radio" checked={opponent === 'none'} onChange={() => setOpponent('none')} />
            ひとりで走る（タイムアタック）
          </label>
          <label>
            <input type="radio" checked={opponent === 'heuristic'} onChange={() => setOpponent('heuristic')} />
            学習なし AI と競走
          </label>
          {agents.filter((a) => a.kind !== 'heuristic').map((a) => (
            <label key={a.id}>
              <input type="radio" checked={opponent === a.id} onChange={() => setOpponent(a.id)} />
              学習した AI「{a.label}」と競走
            </label>
          ))}
        </div>
        {agents.length <= 1 && (
          <p className="muted small">
            学習した AI はまだありません（<code>python -m rl.racer.train</code> で作れます）。
          </p>
        )}
      </section>

      {best !== null && (
        <p className="muted">
          このコースとこの車でのベストラップ: <span className="mono">{formatTime(best)}</span>
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <button type="button" className="primary racer-start" onClick={start} disabled={busy}>
        {busy ? '読み込み中…' : 'スタート'}
      </button>
    </div>
  )
}

/** コースを上から見た形を SVG で描く（選ぶときの目印） */
function CourseMap({ id }: { id: string }) {
  const c = CO.load(id)
  const pts: string[] = []
  const step = Math.max(1, Math.floor(c.n / 120))
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < c.n; i += step) {
    minX = Math.min(minX, c.x[i]); maxX = Math.max(maxX, c.x[i])
    minZ = Math.min(minZ, c.z[i]); maxZ = Math.max(maxZ, c.z[i])
  }
  const scale = 100 / Math.max(maxX - minX, maxZ - minZ)
  for (let i = 0; i < c.n; i += step) {
    pts.push(`${((c.x[i] - minX) * scale).toFixed(1)},${((c.z[i] - minZ) * scale).toFixed(1)}`)
  }
  return (
    <svg viewBox="-8 -8 116 116" className="racer-map" aria-hidden>
      <polygon points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={7}
               strokeLinejoin="round" opacity={0.25} />
      <polygon points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={2.5}
               strokeLinejoin="round" />
    </svg>
  )
}

/** 車の性能を棒グラフで見せる */
function CarBars({ car }: { car: P.Car }) {
  const bars: [string, number][] = [
    ['最高速', car.vmax / 55],
    ['加速', car.accel / 32],
    ['グリップ', car.grip / 14],
    ['小回り', car.steer / 2.8],
  ]
  return (
    <div className="racer-bars">
      {bars.map(([label, v]) => (
        <div key={label}>
          <span className="muted small">{label}</span>
          <div className="racer-bar"><div style={{ width: `${Math.min(v, 1) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  )
}
