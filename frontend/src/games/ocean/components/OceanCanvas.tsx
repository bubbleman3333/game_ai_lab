// canvas を 1 枚置いて、その上に 3D の場面（scene/OceanScene.ts）を動かす。
//
// 毎フレームやること:
//   1. 前のフレームからの経過時間を測る
//   2. 入力を読んでゲームを進める（sim/game.ts）
//   3. 出来事に合わせて音と演出を出す
//   4. 場面を描く（scene/OceanScene.ts）
//   5. HUD に出す値を、React に 20 回/秒だけ渡す（60 回/秒だと画面の作り直しが重い）

import { useEffect, useRef, useState } from 'react'
import type { Input } from '../sim/game'
import { type Cause, type GameEvent, MAX_AIR, MAX_DEPTH, MAX_HP, MAX_STAMINA, type OceanGame, type SharkState } from '../sim/game'
import { ZONES, type ZoneId, zoneIndex } from '../sim/zones'
import { OceanScene } from '../scene/OceanScene'
import { OceanAmbience, oceanSounds } from '../sounds'

/** サメがどっちにいるか（泳ぐ人から見て） */
export type Dir = 'front' | 'back' | 'left' | 'right'

/** HUD に出すための、その瞬間の値 */
export interface Snapshot {
  distance: number
  score: number
  hp: number
  maxHp: number
  air: number
  stamina: number
  underwater: boolean
  /** カメラが水の中（画面の色合い用） */
  cameraUnderwater: boolean
  depth: number
  /** 水深（m。正の値） */
  depthM: number
  zoneId: ZoneId
  zoneName: string
  /** 次の区間までの距離（m）。最後の区間なら null */
  nextZoneIn: number | null
  threat: { dir: Dir; state: SharkState; dist: number } | null
  dead: boolean
  cause: Cause | null
  pearls: number
  dodges: number
  punches: number
  time: number
}

interface Props {
  game: OceanGame
  readInput: () => Input
  onSnapshot: (s: Snapshot) => void
  onEvents?: (e: GameEvent[]) => void
  paused?: boolean
}

const HUD_INTERVAL = 0.05

function playEvent(ev: GameEvent): void {
  switch (ev.kind) {
    case 'sting': return oceanSounds.sting()
    case 'bite': return oceanSounds.bite()
    case 'shark-warn': return oceanSounds.warn()
    case 'shark-charge': return oceanSounds.charge()
    case 'dodge': return oceanSounds.dodge()
    case 'punch': return oceanSounds.punch()
    case 'kick': return oceanSounds.kick()
    case 'pearl': return oceanSounds.pearl()
    case 'zone': return oceanSounds.zone()
    case 'submerge': return oceanSounds.submerge()
    case 'surface': return oceanSounds.surface()
    case 'drowning': return oceanSounds.drowning()
    case 'dead': return oceanSounds.dead()
  }
}

export function OceanCanvas({ game, readInput, onSnapshot, onEvents, paused }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const cb = useRef({ readInput, onSnapshot, onEvents })
  const pausedRef = useRef(paused)
  useEffect(() => {
    cb.current = { readInput, onSnapshot, onEvents }
    pausedRef.current = paused
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let scene: OceanScene
    try {
      scene = new OceanScene(canvas)
    } catch (e) {
      // WebGL が使えない環境（古いブラウザ・リモートデスクトップなど）
      console.error(e)
      setFailed(true)
      return
    }
    const resize = () => scene.resize()
    window.addEventListener('resize', resize)
    resize()

    const ambience = new OceanAmbience()
    ambience.start()
    // デバッグ用: コンソールから window.__ocean で進行を見られる（例: __ocean.player, __ocean.sharks）
    ;(window as unknown as { __ocean?: OceanGame; __oceanScene?: OceanScene }).__ocean = game
    ;(window as unknown as { __oceanScene?: OceanScene }).__oceanScene = scene

    let raf = 0
    let last = performance.now()
    let hudTimer = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const p = game.player
      if (!pausedRef.current) {
        const events = game.update(dt, cb.current.readInput())
        for (const ev of events) playEvent(ev)
        if (events.length) {
          scene.handleEvents(events)
          cb.current.onEvents?.(events)
        }
      }
      const threat = game.threat
      const menace = threat
        ? Math.max(0, 1 - Math.hypot(threat.x - p.x, threat.z - p.z) / 40) * (threat.state === 'charge' ? 1 : 0.6)
        : 0
      ambience.update({
        underwater: game.underwater,
        depth: Math.min(1, p.y / MAX_DEPTH),
        effort: p.dashing ? 1 : 0.25,
        danger: !game.dead && (p.hp <= 2 || (game.underwater && p.air < 25)),
        menace: game.dead ? 0 : menace,
      }, dt)
      scene.update(dt, game)

      hudTimer += dt
      if (hudTimer >= HUD_INTERVAL) {
        hudTimer = 0
        cb.current.onSnapshot(snapshot(game, scene.cameraUnderwater))
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      ambience.stop()
      scene.dispose()
    }
  }, [game])

  if (failed) {
    return (
      <p className="page error">
        3D を表示できませんでした。このブラウザで WebGL が使えるか確かめてください
        （リモートデスクトップや古いブラウザでは使えないことがあります）。
      </p>
    )
  }
  return <canvas ref={canvasRef} className="ocean-canvas" />
}

function snapshot(game: OceanGame, cameraUnderwater: boolean): Snapshot {
  const p = game.player
  const threat = game.threat
  let t: Snapshot['threat'] = null
  if (threat) {
    const dx = threat.x - p.x, dz = threat.z - p.z
    // 前 = +z、右 = -x
    const dir: Dir = Math.abs(dz) > Math.abs(dx) ? (dz > 0 ? 'front' : 'back') : (dx < 0 ? 'right' : 'left')
    t = { dir, state: threat.state, dist: Math.hypot(dx, dz) }
  }
  const zi = zoneIndex(game.zone)
  const next = ZONES[zi + 1]
  return {
    distance: p.z,
    score: game.score,
    hp: p.hp, maxHp: MAX_HP,
    air: p.air / MAX_AIR,
    stamina: p.stamina / MAX_STAMINA,
    underwater: game.underwater,
    cameraUnderwater,
    depth: Math.min(1, p.y / MAX_DEPTH),
    depthM: Math.max(0, -p.y),
    zoneId: game.zone.id,
    zoneName: game.zone.name,
    nextZoneIn: next ? Math.max(0, next.from - p.z) : null,
    threat: t,
    dead: game.dead,
    cause: game.cause,
    pearls: game.pearlsTaken,
    dodges: game.dodges,
    punches: game.punches,
    time: game.time,
  }
}
