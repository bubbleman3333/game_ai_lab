// 画像ファイルを使わず、canvas に描いてテクスチャを作る（権利を気にせず公開でき、読み込みも要らない）。
//
// 建物の壁は「窓の並び 8 列 × 8 階」を 1 枚に描き、壁の大きさに合わせて繰り返し貼る
// （UV を「壁の幅 ÷ (1 列の幅 × 8)」にする。scene/buildCity.ts）。
// 1 枚の中で窓の点き方をばらばらにしてあるので、夜に同じ模様が並んで見えにくい。
//
// 壁 1 種類につき 3 枚:
//   map        色
//   roughness  つや（窓はつるつる = 空が映る、壁はざらざら）
//   emissive   夜に光る窓（昼は明るさ 0 にする）

import * as THREE from 'three'
import { makeRng, pick, range, type Rng } from '../sim/rng'
import type { Style } from '../sim/cityMap'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

function toTexture(c: HTMLCanvasElement, color = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  if (color) t.colorSpace = THREE.SRGBColorSpace
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 16 // 斜めから見た道路・壁がぼやけないように（対応していなければ上限に丸められる）
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  return t
}

/** ざらつき（小さな点を散らす） */
function speckle(g: CanvasRenderingContext2D, w: number, h: number, rng: Rng, n: number, alpha: number, light = false) {
  for (let k = 0; k < n; k++) {
    const v = light ? 255 : 0
    g.fillStyle = `rgba(${v},${v},${v},${rng() * alpha})`
    const s = rng() < 0.9 ? 1 : 2
    g.fillRect(rng() * w, rng() * h, s, s)
  }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`
function shade(c: number, k: number): string {
  const r = Math.min(255, Math.max(0, ((c >> 16) & 255) * k))
  const g = Math.min(255, Math.max(0, ((c >> 8) & 255) * k))
  const b = Math.min(255, Math.max(0, (c & 255) * k))
  return `rgb(${r | 0},${g | 0},${b | 0})`
}

// --- 地面 ----------------------------------------------------------------------------

/** アスファルト（12m 四方ぶん） */
export function asphalt(): THREE.CanvasTexture {
  const rng = makeRng(11)
  const [c, g] = canvas(1024, 1024)
  g.fillStyle = '#3b3c3f'
  g.fillRect(0, 0, 1024, 1024)
  // 補修のあと（少し色の違う四角）
  for (let k = 0; k < 10; k++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? 20 : 70},${rng() < 0.5 ? 20 : 70},${rng() < 0.5 ? 22 : 72},${range(rng, 0.08, 0.2)})`
    g.fillRect(rng() * 1024, rng() * 1024, range(rng, 60, 260), range(rng, 40, 200))
  }
  speckle(g, 1024, 1024, rng, 90000, 0.35)
  speckle(g, 1024, 1024, rng, 50000, 0.18, true)
  // ひび
  g.strokeStyle = 'rgba(15,15,16,0.55)'
  for (let k = 0; k < 14; k++) {
    g.lineWidth = range(rng, 0.8, 2)
    g.beginPath()
    let x = rng() * 1024, y = rng() * 1024
    g.moveTo(x, y)
    for (let s = 0; s < 8; s++) { x += range(rng, -40, 40); y += range(rng, -40, 40); g.lineTo(x, y) }
    g.stroke()
  }
  // タイヤが通るところは少し黒ずんで、つるっとしている
  for (const cx of [300, 724]) {
    const grd = g.createLinearGradient(cx - 90, 0, cx + 90, 0)
    grd.addColorStop(0, 'rgba(0,0,0,0)')
    grd.addColorStop(0.5, 'rgba(0,0,0,0.13)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(cx - 90, 0, 180, 1024)
  }
  return toTexture(c)
}

/** 歩道の敷石（4m 四方ぶん） */
export function paving(): THREE.CanvasTexture {
  const rng = makeRng(12)
  const [c, g] = canvas(512, 512)
  g.fillStyle = '#6f6c66'
  g.fillRect(0, 0, 512, 512)
  const n = 8
  const s = 512 / n
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = range(rng, 0.85, 1.08)
      g.fillStyle = shade(0xa39f96, v)
      g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4)
    }
  }
  speckle(g, 512, 512, rng, 20000, 0.2)
  speckle(g, 512, 512, rng, 8000, 0.12, true)
  return toTexture(c)
}

export function grass(): THREE.CanvasTexture {
  const rng = makeRng(13)
  const [c, g] = canvas(512, 512)
  g.fillStyle = '#3d5a2a'
  g.fillRect(0, 0, 512, 512)
  for (let k = 0; k < 26000; k++) {
    const v = range(rng, 0.7, 1.35)
    g.fillStyle = shade(0x4a6e30, v)
    g.fillRect(rng() * 512, rng() * 512, 1, range(rng, 1, 4))
  }
  for (let k = 0; k < 30; k++) {
    g.fillStyle = `rgba(90,80,40,${range(rng, 0.05, 0.15)})`
    g.beginPath()
    g.arc(rng() * 512, rng() * 512, range(rng, 10, 50), 0, Math.PI * 2)
    g.fill()
  }
  return toTexture(c)
}

export function gravelRoof(): THREE.CanvasTexture {
  const rng = makeRng(14)
  const [c, g] = canvas(256, 256)
  g.fillStyle = '#6b6d70'
  g.fillRect(0, 0, 256, 256)
  speckle(g, 256, 256, rng, 12000, 0.35)
  speckle(g, 256, 256, rng, 6000, 0.25, true)
  return toTexture(c)
}

/** 家の屋根瓦 */
export function roofTiles(): THREE.CanvasTexture {
  const rng = makeRng(15)
  const [c, g] = canvas(256, 256)
  g.fillStyle = '#3a3f48'
  g.fillRect(0, 0, 256, 256)
  for (let y = 0; y < 256; y += 16) {
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fillRect(0, y, 256, 3)
    for (let x = (y / 16) % 2 ? 0 : 8; x < 256; x += 16) {
      g.fillStyle = `rgba(255,255,255,${range(rng, 0.02, 0.08)})`
      g.fillRect(x, y + 3, 14, 12)
    }
  }
  return toTexture(c)
}

/** 水面の凹凸（法線マップ）。なめらかな乱数の高さから傾きを出す */
export function waterNormals(): THREE.CanvasTexture {
  const rng = makeRng(16)
  const N = 256
  const h = new Float32Array(N * N)
  for (let k = 0; k < 60; k++) {
    const fx = Math.floor(range(rng, 1, 9)), fy = Math.floor(range(rng, 1, 9))
    const ph = rng() * Math.PI * 2, a = range(rng, 0.2, 1) / (fx + fy)
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      h[y * N + x] += a * Math.sin(((x * fx + y * fy) / N) * Math.PI * 2 + ph)
    }
  }
  const [c, g] = canvas(N, N)
  const img = g.createImageData(N, N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)]
    const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]
    const i = (y * N + x) * 4
    img.data[i] = 128 + dx * 60
    img.data[i + 1] = 128 + dy * 60
    img.data[i + 2] = 255
    img.data[i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return toTexture(c, false)
}

// --- 建物 ------------------------------------------------------------------------------

export interface FacadeSpec {
  /** 1 列の幅と 1 階の高さ（m） */
  bay: number
  floor: number
}

export const FACADE_SPECS: Record<Style, FacadeSpec> = {
  glass: { bay: 3, floor: 3.8 },
  office: { bay: 3.2, floor: 3.6 },
  concrete: { bay: 3.4, floor: 3.2 },
  brick: { bay: 3, floor: 3.2 },
  warehouse: { bay: 4, floor: 4.5 },
  house: { bay: 2.6, floor: 2.9 },
}

export interface FacadeTextures { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; emissive: THREE.CanvasTexture }

const TILE = 8 // 1 枚に何列・何階ぶん描くか
const WARM = ['#ffd9a0', '#ffe8c0', '#ffcf86', '#fff2dc', '#cfe4ff', '#ffdcb0']

/** 窓の点き方（夜）。同じ建物の同じ階はまとめて点きやすい（1 フロアが同じ会社・家なので） */
function litPattern(rng: Rng, floors: number, bays: number, p: number): boolean[][] {
  const rows: boolean[][] = []
  for (let f = 0; f < floors; f++) {
    const floorOn = rng() < p
    rows.push(Array.from({ length: bays }, () => (floorOn ? rng() < 0.85 : rng() < p * 0.35)))
  }
  return rows
}

export function facade(style: Style): FacadeTextures {
  const rng = makeRng(100 + style.length * 7 + style.charCodeAt(0))
  const W = 1024, H = 1024, EW = 512, EH = 512
  const [cm, gm] = canvas(W, H)
  const [cr, gr] = canvas(W / 2, H / 2)
  const [ce, ge] = canvas(EW, EH)
  const bw = W / TILE, fh = H / TILE
  ge.fillStyle = '#000'
  ge.fillRect(0, 0, EW, EH)
  gr.fillStyle = '#e6e6e6' // 壁はざらざら
  gr.fillRect(0, 0, W / 2, H / 2)
  const lit = litPattern(rng, TILE, TILE, style === 'glass' ? 0.45 : style === 'office' ? 0.5 : 0.55)

  // 窓 1 つを描く（色・つや・夜の光）。y は上から
  const win = (x: number, y: number, w: number, h: number, glass: string, f: number, b: number, frame?: string) => {
    if (frame) { gm.fillStyle = frame; gm.fillRect(x - 3, y - 3, w + 6, h + 6) }
    const grd = gm.createLinearGradient(x, y, x + w * 0.4, y + h)
    grd.addColorStop(0, shade(parseInt(glass.slice(1), 16), 1.35))
    grd.addColorStop(1, glass)
    gm.fillStyle = grd
    gm.fillRect(x, y, w, h)
    gr.fillStyle = '#4a4a4a' // 窓はつるつる（真っ黒 = 鏡にすると夕日を浴びて白飛びする）
    gr.fillRect(x / 2, y / 2, w / 2, h / 2)
    if (lit[f][b]) {
      const col = pick(rng, WARM)
      ge.fillStyle = col
      ge.globalAlpha = range(rng, 0.45, 1)
      ge.fillRect((x * EW) / W, (y * EH) / H, (w * EW) / W, (h * EH) / H)
      ge.globalAlpha = 1
      // カーテン・ブラインドで一部が暗い
      if (rng() < 0.4) {
        ge.fillStyle = 'rgba(0,0,0,0.55)'
        ge.fillRect((x * EW) / W, (y * EH) / H, (w * EW) / W, ((h * EH) / H) * range(rng, 0.2, 0.6))
      }
    }
  }

  switch (style) {
    case 'glass': {
      gm.fillStyle = '#233040'
      gm.fillRect(0, 0, W, H)
      for (let f = 0; f < TILE; f++) for (let b = 0; b < TILE; b++) {
        const tint = pick(rng, ['#2a4a66', '#2d5170', '#274460', '#34566f'])
        win(b * bw + 3, f * fh + 10, bw - 6, fh - 26, tint, f, b)
      }
      // 各階の床の帯と縦の枠
      gm.fillStyle = '#1a232d'
      for (let f = 0; f < TILE; f++) gm.fillRect(0, f * fh + fh - 16, W, 16)
      gm.fillStyle = '#9aa5b1'
      for (let b = 0; b <= TILE; b++) gm.fillRect(b * bw - 2, 0, 4, H)
      gr.fillStyle = '#6a6a6a'
      for (let b = 0; b <= TILE; b++) gr.fillRect((b * bw - 2) / 2, 0, 2, H / 2)
      break
    }
    case 'office': {
      const wall = pick(rng, [0xb8b2a6, 0xa9a49a, 0xc4bcae])
      gm.fillStyle = hex(wall)
      gm.fillRect(0, 0, W, H)
      speckle(gm, W, H, rng, 30000, 0.12)
      for (let f = 0; f < TILE; f++) for (let b = 0; b < TILE; b++) {
        win(b * bw + 14, f * fh + 22, bw - 28, fh - 44, '#1f2a36', f, b, '#5d5f63')
      }
      break
    }
    case 'concrete': {
      gm.fillStyle = '#c9c6bf'
      gm.fillRect(0, 0, W, H)
      speckle(gm, W, H, rng, 40000, 0.14)
      // 雨だれのしみ
      for (let k = 0; k < 40; k++) {
        gm.fillStyle = `rgba(60,60,55,${range(rng, 0.03, 0.08)})`
        gm.fillRect(rng() * W, rng() * H, range(rng, 4, 14), range(rng, 40, 180))
      }
      for (let f = 0; f < TILE; f++) for (let b = 0; b < TILE; b++) {
        win(b * bw + 20, f * fh + 18, bw - 40, fh - 52, '#2b3440', f, b, '#e8e6e0')
        // ベランダの手すり
        gm.fillStyle = '#9b9890'
        gm.fillRect(b * bw + 8, f * fh + fh - 34, bw - 16, 22)
        gm.fillStyle = 'rgba(0,0,0,0.2)'
        gm.fillRect(b * bw + 8, f * fh + fh - 12, bw - 16, 4)
      }
      break
    }
    case 'brick': {
      gm.fillStyle = '#7a3a2a'
      gm.fillRect(0, 0, W, H)
      for (let y = 0; y < H; y += 10) {
        for (let x = (y / 10) % 2 ? 0 : 12; x < W; x += 24) {
          gm.fillStyle = shade(0x8a4530, range(rng, 0.75, 1.15))
          gm.fillRect(x, y, 22, 8)
        }
      }
      for (let f = 0; f < TILE; f++) for (let b = 0; b < TILE; b++) {
        win(b * bw + 26, f * fh + 22, bw - 52, fh - 46, '#24303b', f, b, '#e9e2d6')
        gm.fillStyle = '#6a6258'
        gm.fillRect(b * bw + 20, f * fh + fh - 26, bw - 40, 8) // 窓台
      }
      break
    }
    case 'warehouse': {
      const base = pick(rng, [0x8a959e, 0xa39a86, 0x7d8a7a])
      gm.fillStyle = hex(base)
      gm.fillRect(0, 0, W, H)
      // 波板の縦じま
      for (let x = 0; x < W; x += 8) {
        gm.fillStyle = shade(base, x % 16 ? 0.85 : 1.08)
        gm.fillRect(x, 0, 4, H)
      }
      gr.fillStyle = '#9a9a9a'
      gr.fillRect(0, 0, W / 2, H / 2)
      for (let f = 0; f < TILE; f += 2) for (let b = 0; b < TILE; b++) {
        if (rng() < 0.5) win(b * bw + 30, f * fh + 20, bw - 60, 40, '#3a4450', f, b, '#555')
      }
      speckle(gm, W, H, rng, 20000, 0.15)
      break
    }
    case 'house': {
      const siding = pick(rng, [0xe8e1d0, 0xd8d0bd, 0xc7d3d8, 0xe3d3b8])
      gm.fillStyle = hex(siding)
      gm.fillRect(0, 0, W, H)
      for (let y = 0; y < H; y += 12) {
        gm.fillStyle = 'rgba(0,0,0,0.08)'
        gm.fillRect(0, y, W, 2)
      }
      for (let f = 0; f < TILE; f++) for (let b = 0; b < TILE; b++) {
        if (rng() < 0.35) continue
        win(b * bw + 24, f * fh + 26, bw - 48, fh - 56, '#2a3642', f, b, '#f4f1ea')
      }
      break
    }
  }
  return { map: toTexture(cm), rough: toTexture(cr, false), emissive: toTexture(ce) }
}

// --- 1 階の店 --------------------------------------------------------------------------

const SHOP_NAMES = ['焼肉', 'うどん', 'そば', 'スナック', 'パチンコ', 'カラオケ', '古着', '時計', '歯科', '美容室', '整骨院',
  '中華', 'カレー', 'たこ焼', '雑貨', '家電', '花', 'ケーキ', 'BOOKS', 'CAFE', 'SHOES', 'PHARMACY', '麻雀', '100円',
  'カフェ', 'ラーメン', '薬局', 'BAR', '書店', 'コンビニ', '花屋', '寿司', 'BAKERY', '服', '居酒屋',
  'PIZZA', '不動産', '眼鏡', 'ゲーム', 'CD', '銀行', 'ATM', '牛丼', 'GYM', '靴', '質屋', '喫茶', 'HOTEL']
const SIGN_COLORS = ['#e8413c', '#2e7fd9', '#1fa05a', '#f0a020', '#b23ad1', '#e85a9a', '#22b5c4', '#fafafa']

/** 店が並んだ 1 階（幅 32m・高さ 4.5m ぶん。8 軒） */
export const SHOP_WIDTH = 32
export const SHOP_HEIGHT = 4.5
export function shopfront(variant = 0): FacadeTextures {
  const rng = makeRng(77 + variant * 1013)
  const W = 2048, H = 288
  const [cm, gm] = canvas(W, H)
  const [cr, gr] = canvas(W / 2, H / 2)
  const [ce, ge] = canvas(W / 2, H / 2)
  ge.fillStyle = '#000'
  ge.fillRect(0, 0, W / 2, H / 2)
  gr.fillStyle = '#d0d0d0'
  gr.fillRect(0, 0, W / 2, H / 2)
  const sw = W / 8
  for (let k = 0; k < 8; k++) {
    const x = k * sw
    const wall = pick(rng, [0x3a3a3c, 0x5a5048, 0x2a2e33, 0x6b6660, 0x1e1e20])
    gm.fillStyle = hex(wall)
    gm.fillRect(x, 0, sw, H)
    // 看板
    const sign = pick(rng, SIGN_COLORS)
    const dark = sign === '#fafafa'
    gm.fillStyle = sign
    gm.fillRect(x + 10, 10, sw - 20, 58)
    gm.fillStyle = dark ? '#222' : '#fff'
    gm.font = 'bold 40px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif'
    gm.textAlign = 'center'
    gm.textBaseline = 'middle'
    const name = pick(rng, SHOP_NAMES)
    gm.fillText(name, x + sw / 2, 40)
    ge.fillStyle = sign
    ge.fillRect((x + 10) / 2, 5, (sw - 20) / 2, 29)
    ge.fillStyle = dark ? '#222' : '#fff'
    ge.font = 'bold 20px sans-serif'
    ge.textAlign = 'center'
    ge.textBaseline = 'middle'
    ge.fillText(name, (x + sw / 2) / 2, 20)
    // ショーウィンドウと入口
    const glassY = 84
    const lit = pick(rng, ['#fff1d6', '#e8f4ff', '#ffe3b8', '#f7fff0'])
    const grd = gm.createLinearGradient(0, glassY, 0, H - 12)
    grd.addColorStop(0, '#6c7a86')
    grd.addColorStop(1, '#27303a')
    gm.fillStyle = grd
    gm.fillRect(x + 12, glassY, sw - 24, H - glassY - 12)
    gr.fillStyle = '#151515'
    gr.fillRect((x + 12) / 2, glassY / 2, (sw - 24) / 2, (H - glassY - 12) / 2)
    ge.fillStyle = lit
    ge.globalAlpha = range(rng, 0.5, 0.9)
    ge.fillRect((x + 12) / 2, glassY / 2, (sw - 24) / 2, (H - glassY - 12) / 2)
    ge.globalAlpha = 1
    // 中の棚（影）
    for (let s = 0; s < 3; s++) {
      gm.fillStyle = 'rgba(0,0,0,0.25)'
      gm.fillRect(x + 20 + rng() * (sw - 80), glassY + 60 + s * 40, range(rng, 30, 80), 10)
    }
    gm.fillStyle = hex(wall)
    gm.fillRect(x + sw * 0.62, glassY, 8, H - glassY - 12)
    // 入口のドア
    gm.fillStyle = '#20262c'
    gm.fillRect(x + sw * 0.66, glassY + 10, sw * 0.26, H - glassY - 22)
    // 日よけ
    if (rng() < 0.6) {
      const aw = pick(rng, ['#9a2a2a', '#2a5a9a', '#2e6b3e', '#c58b2a', '#444'])
      for (let s = 0; s < 12; s++) {
        gm.fillStyle = s % 2 ? aw : '#e8e3d8'
        gm.fillRect(x + 12 + s * ((sw - 24) / 12), 70, (sw - 24) / 12, 16)
      }
    }
  }
  return { map: toTexture(cm), rough: toTexture(cr, false), emissive: toTexture(ce) }
}

// --- 光 ----------------------------------------------------------------------------------

/** 丸くぼやけた光（街灯が地面を照らす輪・粒子・ライトのにじみ） */
export function softDot(size = 128, falloff = 2): THREE.CanvasTexture {
  const [c, g] = canvas(size, size)
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (let k = 0; k <= 10; k++) {
    const t = k / 10
    grd.addColorStop(t, `rgba(255,255,255,${(1 - t) ** falloff})`)
  }
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  return toTexture(c, true, false)
}

/** 煙の粒（ふわっとした形のむら入り） */
export function smokePuff(): THREE.CanvasTexture {
  const rng = makeRng(21)
  const [c, g] = canvas(128, 128)
  for (let k = 0; k < 14; k++) {
    const x = 64 + range(rng, -22, 22), y = 64 + range(rng, -22, 22), r = range(rng, 18, 40)
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, 'rgba(255,255,255,0.35)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 128, 128)
  }
  return toTexture(c, true, false)
}

/** 縦長の突き出し看板（16 枚を 1 枚の絵に並べる。4 列 × 4 行） */
export function signAtlas(): FacadeTextures {
  const rng = makeRng(505)
  const W = 1024, H = 1024
  const [cm, gm] = canvas(W, H)
  const [ce, ge] = canvas(W / 2, H / 2)
  const [cr, gr] = canvas(8, 8)
  gr.fillStyle = '#666'
  gr.fillRect(0, 0, 8, 8)
  const cw = W / 4, ch = H / 4
  for (let k = 0; k < 16; k++) {
    const x = (k % 4) * cw, y = Math.floor(k / 4) * ch
    const bg = pick(rng, SIGN_COLORS)
    const fg = bg === '#fafafa' ? '#c01818' : '#fff'
    gm.fillStyle = '#222'
    gm.fillRect(x, y, cw, ch)
    gm.fillStyle = bg
    gm.fillRect(x + 6, y + 6, cw - 12, ch - 12)
    ge.fillStyle = bg
    ge.fillRect((x + 6) / 2, (y + 6) / 2, (cw - 12) / 2, (ch - 12) / 2)
    const name = pick(rng, SHOP_NAMES).slice(0, 4)
    // 縦書き
    const size = Math.min(56, (ch - 30) / name.length)
    for (const [g, sc] of [[gm, 1], [ge, 0.5]] as const) {
      g.fillStyle = fg
      g.font = `bold ${size * sc}px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      ;[...name].forEach((chr, i) => g.fillText(chr, (x + cw / 2) * sc, (y + 20 + size * (i + 0.5)) * sc))
    }
  }
  return { map: toTexture(cm, true, false), rough: toTexture(cr, false), emissive: toTexture(ce, true, false) }
}

/** 自販機の正面（飲み物が並んで光る） */
export function vendingFront(): FacadeTextures {
  const rng = makeRng(606)
  const [cm, gm] = canvas(256, 512)
  const [ce, ge] = canvas(128, 256)
  const [cr, gr] = canvas(8, 8)
  gr.fillStyle = '#444'
  gr.fillRect(0, 0, 8, 8)
  gm.fillStyle = pick(rng, ['#d8d8dc', '#c0202a', '#1f4fa8'])
  gm.fillRect(0, 0, 256, 512)
  ge.fillStyle = '#000'
  ge.fillRect(0, 0, 128, 256)
  // 見本のガラス窓
  gm.fillStyle = '#e8f0f4'
  gm.fillRect(18, 30, 220, 290)
  ge.fillStyle = '#dfefff'
  ge.fillRect(9, 15, 110, 145)
  for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
    const x = 26 + col * 35, y = 44 + row * 70
    gm.fillStyle = pick(rng, ['#c02020', '#20a040', '#e0a020', '#2050c0', '#603010', '#f0f0f0', '#a020a0'])
    gm.fillRect(x, y, 22, 46)
    gm.fillStyle = 'rgba(255,255,255,0.5)'
    gm.fillRect(x + 3, y + 4, 4, 38)
    gm.fillStyle = '#30c040'
    gm.fillRect(x + 4, y + 52, 14, 6)
    ge.fillStyle = '#40ff60'
    ge.fillRect((x + 4) / 2, (y + 52) / 2, 7, 3)
  }
  // 取り出し口とお金の投入口
  gm.fillStyle = '#222'
  gm.fillRect(40, 420, 176, 50)
  gm.fillRect(200, 340, 20, 40)
  return { map: toTexture(cm, true, false), rough: toTexture(cr, false), emissive: toTexture(ce, true, false) }
}

/** 壊れた店の中（暗い店内・倒れた棚・ガラスのぎざぎざの縁）。透明な部分はガラスが割れて無い */
export function smashedShop(): THREE.CanvasTexture {
  const rng = makeRng(707)
  const [c, g] = canvas(512, 384)
  // 暗い店内
  const grd = g.createLinearGradient(0, 0, 0, 384)
  grd.addColorStop(0, '#15120f')
  grd.addColorStop(1, '#2a241e')
  g.fillStyle = grd
  g.fillRect(0, 0, 512, 384)
  // 倒れた棚と、散らばった商品
  for (let k = 0; k < 7; k++) {
    g.save()
    g.translate(range(rng, 40, 470), range(rng, 150, 330))
    g.rotate(range(rng, -0.8, 0.8))
    g.fillStyle = '#4a3a2a'
    g.fillRect(-60, -8, 120, 16)
    g.restore()
  }
  for (let k = 0; k < 120; k++) {
    g.fillStyle = pick(rng, ['#c83030', '#e0c040', '#3070c0', '#40a050', '#e8e8e8', '#8a5a30'])
    g.fillRect(range(rng, 10, 500), range(rng, 200, 380), range(rng, 6, 18), range(rng, 6, 16))
  }
  // 割れ残ったガラスのぎざぎざ（枠の近くだけ白っぽく残る）
  g.fillStyle = 'rgba(200,220,230,0.55)'
  for (const edge of [0, 1, 2, 3]) {
    g.beginPath()
    const pts: [number, number][] = []
    for (let t = 0; t <= 1.0001; t += 0.08) {
      const d = range(rng, 4, 46)
      if (edge === 0) pts.push([t * 512, d])
      else if (edge === 1) pts.push([512 - d, t * 384])
      else if (edge === 2) pts.push([512 - t * 512, 384 - d])
      else pts.push([d, 384 - t * 384])
    }
    const [sx, sy] = edge === 0 ? [0, 0] : edge === 1 ? [512, 0] : edge === 2 ? [512, 384] : [0, 384]
    g.moveTo(sx, sy)
    for (const [x, y] of pts) g.lineTo(x, y)
    g.closePath()
    g.fill()
  }
  // ひび
  g.strokeStyle = 'rgba(230,240,245,0.6)'
  g.lineWidth = 1.5
  for (let k = 0; k < 18; k++) {
    g.beginPath()
    let x = rng() < 0.5 ? range(rng, 0, 512) : rng() < 0.5 ? 0 : 512
    let y = range(rng, 0, 384)
    g.moveTo(x, y)
    for (let s = 0; s < 4; s++) { x += range(rng, -60, 60); y += range(rng, -40, 40); g.lineTo(x, y) }
    g.stroke()
  }
  return toTexture(c, true, false)
}
