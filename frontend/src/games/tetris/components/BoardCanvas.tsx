// 盤面を canvas に描く。操作中のミノとゴースト（落下地点）も描く。
// useLayoutEffect で描くので、React が画面を更新するのと同じフレームで canvas も変わる（useEffect だと 1 フレーム遅れる）。

import { useLayoutEffect, useRef } from 'react'
import { BOARD_WIDTH, CELLS, VISIBLE_HEIGHT, type ActivePiece, type CellColor } from '../engine'
import { PIECE_COLORS } from './colors'

/** 見える 20 段の上に、出現位置が見えるよう 2 段余分に描く */
const DRAW_ROWS = VISIBLE_HEIGHT + 2

interface Props {
  colors: readonly (readonly CellColor[])[]
  current?: ActivePiece | null
  ghostY?: number | null
  cell?: number
  dim?: boolean
}

export function BoardCanvas({ colors, current, ghostY, cell = 28, dim = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const w = BOARD_WIDTH * cell
  const h = DRAW_ROWS * cell

  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const { bg, grid, buffer } = boardTheme()

    const toPx = (x: number, y: number) => [x * cell, (DRAW_ROWS - 1 - y) * cell] as const
    // ブロックは上と左を明るく、下と右を暗くして立体に見せる（平らな四角だと軽く見える）
    const bevel = Math.max(2, Math.round(cell * 0.12))
    const drawCell = (x: number, y: number, color: string, alpha = 1, shaded = true) => {
      if (y >= DRAW_ROWS) return
      const [px, py] = toPx(x, y)
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.fillRect(px, py, cell, cell)
      if (shaded && cell >= 8) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillRect(px, py, cell, bevel)
        ctx.fillRect(px, py + bevel, bevel, cell - bevel)
        ctx.fillStyle = 'rgba(0,0,0,0.35)'
        ctx.fillRect(px + bevel, py + cell - bevel, cell - bevel, bevel)
        ctx.fillRect(px + cell - bevel, py + bevel, bevel, cell - 2 * bevel)
      }
      ctx.globalAlpha = 1
    }

    ctx.fillStyle = buffer
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = bg
    ctx.fillRect(0, 2 * cell, w, VISIBLE_HEIGHT * cell)
    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    for (let x = 1; x < BOARD_WIDTH; x++) {
      ctx.beginPath()
      ctx.moveTo(x * cell + 0.5, 2 * cell)
      ctx.lineTo(x * cell + 0.5, h)
      ctx.stroke()
    }
    for (let y = 1; y < VISIBLE_HEIGHT; y++) {
      ctx.beginPath()
      ctx.moveTo(0, (2 + y) * cell + 0.5)
      ctx.lineTo(w, (2 + y) * cell + 0.5)
      ctx.stroke()
    }

    for (let y = 0; y < Math.min(DRAW_ROWS, colors.length); y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        const c = colors[y][x]
        if (c) drawCell(x, y, PIECE_COLORS[c], dim ? 0.5 : 1)
      }
    }
    if (current) {
      const cells = CELLS[current.type][current.rot]
      if (ghostY != null && ghostY !== current.y) {
        for (const [dx, dy] of cells) drawCell(current.x + dx, ghostY + dy, PIECE_COLORS[current.type], 0.3, false)
      }
      for (const [dx, dy] of cells) drawCell(current.x + dx, current.y + dy, PIECE_COLORS[current.type])
    }
  })

  return <canvas ref={ref} width={w} height={h} className="board-canvas" />
}

// 配色（CSS 変数）は毎回 getComputedStyle で読むと重いので、テーマが変わったときだけ読み直す
let themeCache: { key: string; bg: string; grid: string; buffer: string } | null = null
function boardTheme() {
  const key = document.documentElement.dataset.theme ?? ''
  if (!themeCache || themeCache.key !== key) {
    const css = getComputedStyle(document.documentElement)
    themeCache = {
      key,
      bg: css.getPropertyValue('--board-bg').trim() || '#111',
      grid: css.getPropertyValue('--board-grid').trim() || '#222',
      buffer: css.getPropertyValue('--board-buffer').trim() || '#0a0a0a',
    }
  }
  return themeCache
}
