// ブロブチェインの盤面を canvas に描く。ぷるっとした粒・つながりの表現・はじける演出・連鎖の文字・画面の揺れ。
// 毎フレーム描き直す（useGameLoop から draw を呼ぶ）。色は CSS 変数（--blob-1〜4 など）。

import { useEffect, useRef } from 'react'
import type { BlobController } from '../engine/controller'
import { GARBAGE, H, VISIBLE_H, W, childPos } from '../engine/rules'

const CELL = 44
const PAD = 8
export const CANVAS_W = W * CELL + PAD * 2
export const CANVAS_H = VISIBLE_H * CELL + PAD * 2 + CELL * 0.6 // 上に 13 段目を少しだけ見せる

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
  r: number
}

interface ChainText {
  text: string
  x: number
  y: number
  start: number
  big: boolean
}

/** 演出の状態（粒子・連鎖の文字・揺れ）。controller のイベントから作る */
export class Effects {
  particles: Particle[] = []
  texts: ChainText[] = []
  shakeUntil = 0
  shakePower = 0

  burst(cells: { i: number; color: number }[], colors: string[], now: number, chain: number): void {
    let sx = 0
    let sy = 0
    for (const { i, color } of cells) {
      const x = (i % W) + 0.5
      const y = Math.floor(i / W) + 0.5
      sx += x
      sy += y
      const n = 8 + chain * 2
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2
        const sp = 2 + Math.random() * (4 + chain)
        this.particles.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 3, life: 1,
          color: colors[color] ?? '#999', r: 0.06 + Math.random() * 0.1,
        })
      }
    }
    if (chain >= 1) {
      this.texts.push({ text: `${chain} 連鎖!`, x: sx / cells.length, y: sy / cells.length, start: now, big: chain >= 4 })
    }
    if (chain >= 3) {
      this.shakeUntil = now + 250 + chain * 60
      this.shakePower = Math.min(12, 2 + chain * 1.5)
    }
  }

  allClear(now: number): void {
    this.texts.push({ text: '全消し!!', x: W / 2, y: VISIBLE_H / 2, start: now, big: true })
  }
}

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function BlobCanvas({ controller, effects, draw }: {
  controller: BlobController
  effects: Effects
  draw: { current: ((now: number) => void) | null }
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!ctx) return
    let last = performance.now()
    draw.current = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      render(ctx, controller, effects, now, dt)
    }
    return () => {
      draw.current = null
    }
  }, [controller, effects, draw])

  return <canvas ref={ref} width={CANVAS_W} height={CANVAS_H} className="blob-canvas" />
}

// ---------------------------------------------------------------------------------

function blobColors(): string[] {
  return ['', css('--blob-1', '#ff5470'), css('--blob-2', '#3ecf8e'), css('--blob-3', '#4d8dff'),
    css('--blob-4', '#ffc93c'), css('--blob-garbage', '#b9b6c9')]
}

function render(ctx: CanvasRenderingContext2D, c: BlobController, fx: Effects, now: number, dt: number): void {
  const g = c.game
  const colors = blobColors()
  ctx.save()
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

  // 揺れ
  if (now < fx.shakeUntil) {
    const p = fx.shakePower * ((fx.shakeUntil - now) / 400)
    ctx.translate((Math.random() - 0.5) * p, (Math.random() - 0.5) * p)
  }

  // 盤の背景（ガラスのような板 + ゆっくり動く光）
  const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H)
  bg.addColorStop(0, css('--blob-panel-top', 'rgba(40,30,80,0.85)'))
  bg.addColorStop(1, css('--blob-panel-bottom', 'rgba(15,20,45,0.9)'))
  roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 18)
  ctx.fillStyle = bg
  ctx.fill()
  const shine = ctx.createRadialGradient(
    CANVAS_W * (0.5 + 0.3 * Math.sin(now / 3000)), CANVAS_H * 0.3, 10, CANVAS_W / 2, CANVAS_H * 0.3, CANVAS_W,
  )
  shine.addColorStop(0, 'rgba(255,255,255,0.08)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = shine
  ctx.fill()

  // 座標変換: 盤のマス (x, y) → 画面の中心
  const X = (x: number) => PAD + (x + 0.5) * CELL
  const Y = (y: number) => CANVAS_H - PAD - (y + 0.5) * CELL

  // 出現位置の目印（×）
  ctx.strokeStyle = 'rgba(255,90,90,0.35)'
  ctx.lineWidth = 3
  const mx = X(2)
  const my = Y(11)
  ctx.beginPath()
  ctx.moveTo(mx - 10, my - 10)
  ctx.lineTo(mx + 10, my + 10)
  ctx.moveTo(mx + 10, my - 10)
  ctx.lineTo(mx - 10, my + 10)
  ctx.stroke()

  // 落ちている途中の粒（アニメーション）
  const anim = c.anim
  const t = anim && anim.duration > 0 ? Math.min(1, (now - anim.start) / anim.duration) : 1
  const falling = new Map<number, number>() // マス番号 → 描く y
  if (anim?.moved && (c.phase === 'settle' || c.phase === 'garbage')) {
    const ease = 1 - (1 - t) * (1 - t)
    for (const [x, from, to] of anim.moved) falling.set(to * W + x, from + (to - from) * ease)
  }

  // 盤の粒
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = g.field.get(x, y)
      if (!v) continue
      const i = y * W + x
      const dy = falling.get(i) ?? y
      const linked = v !== GARBAGE && !falling.has(i)
      drawBlob(ctx, X(x), Y(dy), v, colors, now, {
        right: linked && g.field.get(x + 1, y) === v && !falling.has(i + 1),
        up: linked && y + 1 < VISIBLE_H && g.field.get(x, y + 1) === v && !falling.has(i + W),
      })
    }
  }

  // はじける粒
  if (anim?.popped && c.phase === 'pop') {
    for (const { i, color } of anim.popped) {
      const x = i % W
      const y = Math.floor(i / W)
      const s = t < 0.35 ? 1 + t * 0.6 : Math.max(0, 1.2 - (t - 0.35) * 2)
      ctx.globalAlpha = t < 0.35 ? 1 : Math.max(0, 1 - (t - 0.35) / 0.65)
      // 光る輪
      ctx.strokeStyle = colors[color]
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(X(x), Y(y), CELL * 0.45 * (1 + t), 0, Math.PI * 2)
      ctx.stroke()
      drawBlob(ctx, X(x), Y(y), color, colors, now, {}, s)
      ctx.globalAlpha = 1
    }
  }

  // 操作中の組とゴースト
  const p = g.current
  if (p && c.phase === 'play') {
    const ly = g.landingY()
    const [lcx, lcy] = childPos({ ...p, y: ly })
    ctx.globalAlpha = 0.28
    drawBlob(ctx, X(p.x), Y(ly), p.axis, colors, now, {})
    drawBlob(ctx, X(lcx), Y(lcy), p.child, colors, now, {})
    ctx.globalAlpha = 1
    const off = -c.fallProgress * 0.6 // 1 マス落ちるまでをなめらかに
    const [cx, cy] = childPos(p)
    drawBlob(ctx, X(p.x), Y(p.y + off), p.axis, colors, now, {}, 1, true)
    drawBlob(ctx, X(cx), Y(cy + off), p.child, colors, now, {})
  }

  // 粒子
  fx.particles = fx.particles.filter((q) => q.life > 0)
  for (const q of fx.particles) {
    q.x += q.vx * dt
    q.y += q.vy * dt
    q.vy -= 9 * dt
    q.life -= dt * 1.4
    ctx.globalAlpha = Math.max(0, q.life)
    ctx.fillStyle = q.color
    ctx.beginPath()
    ctx.arc(PAD + q.x * CELL, CANVAS_H - PAD - q.y * CELL, q.r * CELL, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // 連鎖の文字
  fx.texts = fx.texts.filter((tx) => now - tx.start < 1300)
  for (const tx of fx.texts) {
    const k = (now - tx.start) / 1300
    const size = (tx.big ? 40 : 30) * (k < 0.15 ? 0.6 + k * 2.7 : 1)
    ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3
    ctx.font = `900 ${size}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    const tx0 = Math.min(Math.max(PAD + tx.x * CELL, 80), CANVAS_W - 80)
    const ty0 = CANVAS_H - PAD - tx.y * CELL - k * 40
    const grad = ctx.createLinearGradient(0, ty0 - size, 0, ty0)
    grad.addColorStop(0, '#fff7a8')
    grad.addColorStop(1, tx.big ? '#ff6ad5' : '#ffb347')
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(40,10,60,0.85)'
    ctx.strokeText(tx.text, tx0, ty0)
    ctx.fillStyle = grad
    ctx.shadowColor = tx.big ? '#ff6ad5' : '#ffb347'
    ctx.shadowBlur = 16
    ctx.fillText(tx.text, tx0, ty0)
    ctx.shadowBlur = 0
  }
  ctx.globalAlpha = 1

  // 13 段目の上に影（見えにくくして、ここが画面外であることを示す）
  const top = ctx.createLinearGradient(0, 0, 0, CELL * 1.2)
  top.addColorStop(0, css('--blob-panel-top', 'rgba(40,30,80,0.95)'))
  // 透明側も同じ色にする（黒の透明に向かうと、明るい配色で灰色ににごるため）
  top.addColorStop(1, css('--blob-panel-top-clear', 'rgba(40,30,80,0)'))
  ctx.fillStyle = top
  roundRect(ctx, 0, 0, CANVAS_W, CELL * 1.2, 18)
  ctx.fill()
  ctx.restore()
}

/** 1 粒を描く。links: 同じ色の隣とつなげる向き（くっついて見える）。main: 操作中の軸（少し光らせる） */
function drawBlob(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, color: number, colors: string[], now: number,
  links: { right?: boolean; up?: boolean }, scale = 1, main = false,
): void {
  const r = CELL * 0.44 * scale
  const base = colors[color]
  const garbage = color === GARBAGE
  // つながり（隣の粒との間を同じ色で埋める）
  ctx.fillStyle = base
  if (links.right) ctx.fillRect(cx, cy - r * 0.62, CELL, r * 1.24)
  if (links.up) ctx.fillRect(cx - r * 0.62, cy - CELL, r * 1.24, CELL)

  // ぷるっと揺れる形（ゆっくり伸び縮み）
  const wob = garbage ? 0 : Math.sin(now / 380 + cx * 0.05 + cy * 0.03) * 0.035
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.1)
  g.addColorStop(0, lighten(base, 0.55))
  g.addColorStop(0.55, base)
  g.addColorStop(1, darken(base, 0.35))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(cx, cy, r * (1 + wob), r * (1 - wob), 0, 0, Math.PI * 2)
  ctx.fill()
  if (main) {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = 2
    ctx.stroke()
  }
  // つや
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.beginPath()
  ctx.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.28, r * 0.16, -0.5, 0, Math.PI * 2)
  ctx.fill()
  if (garbage) return
  // 目（まばたきする）
  const blink = Math.sin(now / 1700 + cx * 0.3) > 0.985
  ctx.fillStyle = '#fff'
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.ellipse(cx + s * r * 0.3, cy + r * 0.05, r * 0.18, blink ? r * 0.03 : r * 0.22, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  if (!blink) {
    ctx.fillStyle = '#20183a'
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(cx + s * r * 0.3, cy + r * 0.1, r * 0.1, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function mix(hex: string, target: number, k: number): string {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  const ch = m.slice(1).map((h) => Math.round(parseInt(h, 16) + (target - parseInt(h, 16)) * k))
  return `rgb(${ch.join(',')})`
}
const lighten = (hex: string, k: number) => mix(hex, 255, k)
const darken = (hex: string, k: number) => mix(hex, 0, k)

/** ネクストの小さな表示 */
export function PairPreview({ pair, size = 26 }: { pair: [number, number]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const colors = blobColors()
    ctx.clearRect(0, 0, size, size * 2)
    const scale = size / CELL
    ctx.save()
    ctx.scale(scale, scale)
    drawBlob(ctx, CELL / 2, CELL * 0.5, pair[1], colors, 0, { up: false })
    drawBlob(ctx, CELL / 2, CELL * 1.5, pair[0], colors, 0, {})
    ctx.restore()
  }, [pair, size])
  return <canvas ref={ref} width={size} height={size * 2} className="blob-preview" />
}

/** 相手の盤（オンライン対戦）。rows は下の行から各行 6 文字（'0' 空き / '1'〜'5'） */
export function MiniField({ rows, width = 150, dim = false }: { rows: string[]; width?: number; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const height = Math.round((width * CANVAS_H) / CANVAS_W)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const colors = blobColors()
    const get = (x: number, y: number) => (x < 0 || x >= W || y < 0 || y >= rows.length ? 0 : Number(rows[y][x]) || 0)
    ctx.clearRect(0, 0, width, height)
    ctx.save()
    ctx.scale(width / CANVAS_W, height / CANVAS_H)
    const bg = ctx.createLinearGradient(0, 0, 0, CANVAS_H)
    bg.addColorStop(0, css('--blob-panel-top', 'rgba(40,30,80,0.85)'))
    bg.addColorStop(1, css('--blob-panel-bottom', 'rgba(15,20,45,0.9)'))
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 18)
    ctx.fillStyle = bg
    ctx.fill()
    ctx.globalAlpha = dim ? 0.35 : 1
    for (let y = 0; y < Math.min(rows.length, H); y++) {
      for (let x = 0; x < W; x++) {
        const v = get(x, y)
        if (!v) continue
        const linked = v !== GARBAGE
        drawBlob(ctx, PAD + (x + 0.5) * CELL, CANVAS_H - PAD - (y + 0.5) * CELL, v, colors, 0, {
          right: linked && get(x + 1, y) === v,
          up: linked && y + 1 < VISIBLE_H && get(x, y + 1) === v,
        })
      }
    }
    ctx.restore()
  }, [rows, width, height, dim])
  return <canvas ref={ref} width={width} height={height} className="blob-mini" />
}
