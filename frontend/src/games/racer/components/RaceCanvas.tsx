// canvas を 1 枚置いて、その上に 3D の場面（scene/RacerScene.ts）を動かす。
//
// 毎フレームやること:
//   1. 前のフレームからの経過時間を測る
//   2. レースを その時間ぶん進める（game/race.ts → engine/physics.ts）
//   3. 車とカメラを新しい位置に置いて描く（scene/RacerScene.ts）
//   4. HUD に出す値を、React に 20 回/秒だけ渡す（60 回/秒だと画面の作り直しが重い）

import { useEffect, useRef, useState } from 'react'
import type * as P from '../engine/physics'
import type { Race, RaceEvent } from '../game/race'
import { RacerScene } from '../scene/RacerScene'
import { RaceEngineSound, racerSounds } from '../sounds'
import { themeFor } from '../scene/themes'

/** 横滑りの速さ（タイヤが鳴くかの判断に使う） */
function lateralSpeed(s: P.State): number {
  return s.vx * -Math.cos(s.yaw) + s.vz * Math.sin(s.yaw)
}

/** 出来事に合わせて音を鳴らす */
function playEvent(ev: RaceEvent, fallingSpeed: number, won: () => boolean): void {
  switch (ev.kind) {
    case 'land': return racerSounds.land(fallingSpeed)
    case 'hit': return racerSounds.hit()
    case 'trick': return racerSounds.trick(ev.value ?? 1)
    case 'fall': return racerSounds.fall()
    case 'boost': return racerSounds.boost()
    case 'lap': return racerSounds.lap()
    case 'finish': return racerSounds.finish(won())
  }
}

/** HUD に出すための、その瞬間の値 */
export interface Snapshot {
  /** 速さ（km/h） */
  speed: number
  lap: number
  laps: number
  place: number
  total: number
  /** スタートからの時間（秒）。カウントダウン中はマイナス */
  time: number
  lapTimes: number[]
  bestLap: number | null
  boost: number
  airborne: boolean
  finished: boolean
}

interface Props {
  race: Race
  /** 人の操作を読む。呼ばれるたびに今の入力を返す */
  readInput: (dt: number) => [number, number, number]
  onSnapshot: (s: Snapshot) => void
  onEvents?: (e: RaceEvent[]) => void
  /** 止めるとカウントダウンも進まない（設定画面を開いているときなど） */
  paused?: boolean
}

const HUD_INTERVAL = 0.05

export function RaceCanvas({ race, readInput, onSnapshot, onEvents, paused }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  // 毎フレーム使うものを ref に入れておく（描き直しのたびにループを作り直さないため）
  const cb = useRef({ readInput, onSnapshot, onEvents })
  const pausedRef = useRef(paused)
  useEffect(() => {
    cb.current = { readInput, onSnapshot, onEvents }
    pausedRef.current = paused
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let scene: RacerScene
    try {
      scene = new RacerScene(canvas, race.course, themeFor(race.course.theme))
    } catch (e) {
      // WebGL が使えない環境（古いブラウザ・リモートデスクトップなど）
      console.error(e)
      setFailed(true)
      return
    }
    for (const r of race.racers) scene.addCar(r.carId, r.color)
    const follow = race.racers.indexOf(race.player)

    const resize = () => scene.resize()
    window.addEventListener('resize', resize)
    resize()

    // 音（エンジンは鳴らしっぱなし、出来事は 1 回ずつ）
    const engineSound = new RaceEngineSound()
    engineSound.start()
    let lastCount = 4 // 直前に鳴らしたカウントダウンの数字

    let raf = 0
    let last = performance.now()
    let hudTimer = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const me = race.player
      const fallingSpeed = Math.abs(me.state.vy) // 着地音の大きさに使う（進める前の値）
      let scraping = false
      if (!pausedRef.current) {
        const input = cb.current.readInput(dt)
        const events = race.update(dt, input)
        for (const ev of events) {
          if (ev.who !== follow) continue
          if (ev.kind === 'hit') scraping = true
          playEvent(ev, fallingSpeed, () => race.place(me) === 1)
        }
        if (events.length) cb.current.onEvents?.(events)

        // カウントダウン（3・2・1 とスタート）
        const n = race.time < 0 ? Math.min(Math.ceil(-race.time), 3) : 0
        if (n !== lastCount) {
          lastCount = n
          racerSounds.count(n)
        }
      }
      engineSound.update({
        speed: Math.hypot(me.state.vx, me.state.vz),
        vmax: race.car(me).vmax,
        throttle: race.started ? me.throttle : 0,
        slip: lateralSpeed(me.state),
        grounded: me.state.on_ground > 0.5,
        boost: me.state.boost,
        scraping,
      })
      scene.update(dt, race.racers.map((r) => ({ state: r.state, steer: r.steer })), follow)

      hudTimer += dt
      if (hudTimer >= HUD_INTERVAL) {
        hudTimer = 0
        const me = race.player
        cb.current.onSnapshot({
          speed: Math.hypot(me.state.vx, me.state.vz) * 3.6,
          lap: Math.min(me.state.lap + 1, race.laps),
          laps: race.laps,
          place: race.place(me),
          total: race.racers.length,
          time: race.time,
          lapTimes: me.lapTimes,
          bestLap: race.bestLap(me),
          boost: me.state.boost,
          airborne: me.state.on_ground < 0.5,
          finished: me.finishedAt !== null,
        })
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      engineSound.stop()
      scene.dispose()
    }
  }, [race])

  if (failed) {
    return (
      <p className="page error">
        3D を表示できませんでした。このブラウザで WebGL が使えるか確かめてください
        （リモートデスクトップや古いブラウザでは使えないことがあります）。
      </p>
    )
  }
  return <canvas ref={canvasRef} className="racer-canvas" />
}
