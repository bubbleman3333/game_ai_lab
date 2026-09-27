// ミニマップ（左下）と、M キーで開く大きな地図。
// canvas に 2D で描く。小さい地図は自分の向きが常に上、大きい地図は +z が上（北）。
// ゲームの状態を直接読んで、1 秒に 10 回描き直す。

import { useEffect, useRef } from 'react'
import { BLOCK_HALF, SEAWALL, type CityMap } from '../sim/cityMap'
import type { Game } from '../sim/game'

interface Props {
  game: Game
  big: boolean
}

const WATER = '#1c3346'
const ROAD = '#5b5f66'
const BLOCK: Record<string, string> = {
  downtown: '#2a2d33', midtown: '#30343a', residential: '#343a36', industrial: '#3a3530', park: '#2f5a33',
}
const MARKER_COLOR: Record<string, string> = {
  delivery: '#3ad0ff', reach: '#3ad0ff', rampage: '#ff4a4a', escape: '#6a8cff', checkpoints: '#3ad0ff', takedown: '#ff7a2a',
}

function drawCity(g: CanvasRenderingContext2D, map: CityMap) {
  g.fillStyle = ROAD
  g.fillRect(-SEAWALL, -SEAWALL, SEAWALL * 2, SEAWALL * 2)
  for (const b of map.blocks) {
    g.fillStyle = BLOCK[b.district]
    g.fillRect(b.cx - BLOCK_HALF, b.cz - BLOCK_HALF, BLOCK_HALF * 2, BLOCK_HALF * 2)
  }
  g.fillStyle = 'rgba(255,255,255,0.07)'
  for (const B of map.buildings) g.fillRect(B.x0, B.z0, B.x1 - B.x0, B.z1 - B.z0)
}

export function Minimap({ game, big }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const g = canvas.getContext('2d')!
    let blink = 0
    const draw = () => {
      blink++
      const dpr = Math.min(window.devicePixelRatio, 2)
      const S = canvas.clientWidth
      if (canvas.width !== S * dpr) { canvas.width = S * dpr; canvas.height = S * dpr }
      const me = game.player.body
      const R = big ? SEAWALL * 1.04 : 230 // 半径（m）
      const k = (S / 2 / R) * dpr
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.fillStyle = WATER
      g.fillRect(0, 0, canvas.width, canvas.height)
      // 世界座標 → 画面: 小さい地図は自分の向きが上
      let a: number, b: number, c: number, d: number
      if (big) { a = -k; b = 0; c = 0; d = -k }
      else {
        const cs = Math.cos(me.yaw), sn = Math.sin(me.yaw)
        a = -cs * k; c = sn * k; b = -sn * k; d = -cs * k
      }
      const cx = big ? 0 : me.x, cz = big ? 0 : me.z
      const e = (S * dpr) / 2 - (a * cx + c * cz)
      const f = (S * dpr) / 2 - (b * cx + d * cz)
      g.setTransform(a, b, c, d, e, f)
      drawCity(g, game.map)
      const toScreen = (x: number, z: number): [number, number] => [a * x + c * z + e, b * x + d * z + f]
      g.setTransform(1, 0, 0, 1, 0, 0)
      const W = S * dpr
      const dot = (x: number, z: number, r: number, color: string, clampEdge = false) => {
        let [sx, sy] = toScreen(x, z)
        const m = r + 3
        if (clampEdge) {
          sx = Math.min(Math.max(sx, m), W - m)
          sy = Math.min(Math.max(sy, m), W - m)
        } else if (sx < -m || sy < -m || sx > W + m || sy > W + m) return
        g.beginPath()
        g.arc(sx, sy, r, 0, Math.PI * 2)
        g.fillStyle = color
        g.fill()
        g.lineWidth = 1.5 * dpr
        g.strokeStyle = 'rgba(0,0,0,0.7)'
        g.stroke()
      }
      // ミッションの輪
      const mission = game.mission
      if (!mission) {
        for (const m of game.markers) {
          dot(m.x, m.z, (m.story ? 7 : 4.5) * dpr, m.story ? '#ffc53a' : MARKER_COLOR[m.def.kind], m.story)
          if (big) {
            const [sx, sy] = toScreen(m.x, m.z)
            g.font = `${11 * dpr}px sans-serif`
            g.fillStyle = '#fff'
            g.fillText(m.story ? `★ ${m.def.title}` : m.def.title, sx + 8 * dpr, sy + 4 * dpr)
          }
        }
      } else if (mission.target) {
        dot(mission.target[0], mission.target[1], 6 * dpr, '#4aff7a', true)
      }
      // 車
      for (const v of game.vehicles) {
        if (v === game.player) continue
        if (v.id === game.targetVehicle) dot(v.body.x, v.body.z, 5 * dpr, '#ff3030', true)
        else if (v.siren) dot(v.body.x, v.body.z, 4 * dpr, blink % 4 < 2 ? '#ff3b3b' : '#3b6bff')
      }
      // 自分（向きのわかる三角）
      const [px, py] = toScreen(me.x, me.z)
      g.save()
      g.translate(px, py)
      // 大きい地図: 前 (sin yaw, cos yaw) は画面では (−sin yaw, −cos yaw)。上向きの三角を −yaw 回すと合う
      g.rotate(big ? -me.yaw : 0)
      g.beginPath()
      g.moveTo(0, -8 * dpr)
      g.lineTo(5.5 * dpr, 6 * dpr)
      g.lineTo(0, 3 * dpr)
      g.lineTo(-5.5 * dpr, 6 * dpr)
      g.closePath()
      g.fillStyle = '#fff'
      g.fill()
      g.strokeStyle = '#000'
      g.lineWidth = 1.5 * dpr
      g.stroke()
      g.restore()
    }
    draw()
    const id = window.setInterval(draw, 100)
    return () => window.clearInterval(id)
  }, [game, big])

  return <canvas ref={ref} className={big ? 'city-bigmap' : 'city-minimap'} />
}
