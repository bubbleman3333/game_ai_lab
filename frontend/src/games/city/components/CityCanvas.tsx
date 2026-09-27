// canvas を 1 枚置いて、ゲーム（sim/game.ts）・3D（scene/CityScene.ts）・音（audio.ts）を毎フレーム回す。
//
// 毎フレーム:
//   1. 入力を読む → 2. ゲームを進める → 3. 出来事を 3D と音に渡す → 4. 描く
//   5. HUD に出す値を、React に 1 秒 15 回だけ渡す（毎フレームだと画面の作り直しが重い）

import { useEffect, useRef, useState } from 'react'
import { CityAudio } from '../audio'
import type { CityInput } from '../input'
import type { Game, GameEvent } from '../sim/game'
import { speedOf } from '../sim/vehicle'
import { CityScene, type Quality } from '../scene/CityScene'

export interface Snapshot {
  speed: number
  health: number
  stars: number
  seen: boolean
  evade: number
  bust: number
  score: number
  combo: number
  state: 'play' | 'busted' | 'wasted'
  clock: number
  car: string
  canCarjack: boolean
  cameraMode: number
}

interface Props {
  game: Game
  input: CityInput
  quality: Quality
  paused: boolean
  onSnapshot: (s: Snapshot) => void
  onEvents: (e: GameEvent[]) => void
  onPause: () => void
  onToggleMap: () => void
}

const HUD_INTERVAL = 1 / 15

export function CityCanvas({ game, input, quality, paused, onSnapshot, onEvents, onPause, onToggleMap }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const cb = useRef({ onSnapshot, onEvents, onPause, onToggleMap, paused })
  useEffect(() => { cb.current = { onSnapshot, onEvents, onPause, onToggleMap, paused } })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let scene: CityScene
    try {
      scene = new CityScene(canvas, game, quality)
    } catch (e) {
      console.error(e)
      setFailed(true)
      return
    }
    const detach = input.attach(canvas)
    const resize = () => scene.resize()
    window.addEventListener('resize', resize)
    const audio = new CityAudio()
    // ブラウザは操作があるまで音を出させないので、最初の操作で鳴らし始める
    const unlock = () => audio.start(game.config.theme)
    window.addEventListener('keydown', unlock)
    window.addEventListener('pointerdown', unlock)
    unlock()
    ;(window as unknown as { __city: unknown }).__city = { game, scene } // デバッグ用（コンソールから見る）

    let raf = 0
    let last = performance.now()
    let hud = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (input.take('pause')) cb.current.onPause()
      if (input.take('map')) cb.current.onToggleMap()
      if (input.take('camera')) scene.cameraMode = (scene.cameraMode + 1) % 3
      scene.lookBack = input.isHeld('lookback')
      scene.orbit = input.orbit
      const running = !cb.current.paused
      if (running) {
        const events = game.update(dt, input.read(dt))
        if (events.length) {
          scene.onEvents(events)
          audio.onEvents(events, game.player)
          cb.current.onEvents(events)
        }
      }
      scene.update(running ? dt : 0)
      const cam = scene.camera
      const dir = cam.getWorldDirection(cam.position.clone().set(0, 0, 0))
      const panic = game.peds.list.filter((p) => p.mode === 'flee').length
      audio.update(running ? dt : 0, { x: cam.position.x, y: cam.position.y, z: cam.position.z, fx: dir.x, fy: dir.y, fz: dir.z },
                   game.player, game.vehicles, sceneNight(game.clock), panic, game.heli)

      hud += dt
      if (hud >= HUD_INTERVAL) {
        hud = 0
        const me = game.player
        cb.current.onSnapshot({
          speed: speedOf(me.body) * 3.6,
          health: Math.max(0, me.health / me.spec.hp),
          stars: game.stars,
          seen: game.seen,
          evade: game.evade,
          bust: game.bust,
          score: game.score,
          combo: game.combo,
          state: game.state,
          clock: game.clock,
          car: me.spec.name,
          canCarjack: speedOf(me.body) < 4 && game.vehicles.some((v) => v !== me && !v.wrecked &&
            Math.hypot(v.body.x - me.body.x, v.body.z - me.body.z) < 7),
          cameraMode: scene.cameraMode,
        })
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      detach()
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', unlock)
      window.removeEventListener('pointerdown', unlock)
      audio.stop()
      scene.dispose()
    }
  }, [game, input, quality])

  if (failed) {
    return <p className="page error">3D を表示できませんでした。このブラウザで WebGL が使えるか確かめてください。</p>
  }
  return <canvas ref={ref} className="city-canvas" />
}

/** 夜の度合い（音の環境音の切り替え用。CityScene と同じ目安） */
function sceneNight(clock: number): number {
  const elev = Math.sin(((clock - 6) / 12) * Math.PI) * 62
  return Math.min(1, Math.max(0, (3 - elev) / 12))
}
