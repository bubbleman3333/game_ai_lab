// 絵の素材（テクスチャ）を canvas でその場で描く。画像ファイルは使わない。
// 狐火・光のにじみ・月（影はシェーダーで描く: shade.ts）。どれも一度作ったら使い回す（disposeTextures で片づける）。

import * as THREE from 'three'

const cache = new Map<string, THREE.CanvasTexture>()

function make(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const hit = cache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  draw(g, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  cache.set(key, tex)
  return tex
}

/** まんなかが白く、外へ向かって透明になる丸（光のにじみ・ホタル） */
export function glowTexture(): THREE.CanvasTexture {
  return make('glow', 128, (g, s) => {
    const r = s / 2
    const grad = g.createRadialGradient(r, r, 0, r, r, r)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
  })
}

/** 狐火（青い炎）。縦長のしずく形 */
export function foxFireTexture(): THREE.CanvasTexture {
  return make('fox', 128, (g, s) => {
    g.save()
    g.translate(s / 2, s * 0.6)
    g.scale(1, 1.6)
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.3, 'rgba(150,220,255,0.9)')
    grad.addColorStop(0.7, 'rgba(40,120,255,0.35)')
    grad.addColorStop(1, 'rgba(40,120,255,0)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(0, 0, s * 0.32, 0, Math.PI * 2)
    g.fill()
    g.restore()
  })
}

/** 月の円盤（ふちを少しぼかし、薄い模様を入れる） */
export function moonTexture(): THREE.CanvasTexture {
  return make('moon', 256, (g, s) => {
    const r = s / 2
    const grad = g.createRadialGradient(r * 0.9, r * 0.9, 0, r, r, r * 0.92)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.92, 'rgba(235,235,225,1)')
    grad.addColorStop(1, 'rgba(235,235,225,0)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(r, r, r * 0.92, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = 'rgba(150,150,160,0.18)'
    for (const [x, y, rr] of [[0.38, 0.4, 0.14], [0.62, 0.55, 0.1], [0.5, 0.7, 0.08], [0.66, 0.33, 0.06]]) {
      g.beginPath()
      g.arc(s * x, s * y, s * rr, 0, Math.PI * 2)
      g.fill()
    }
  })
}

export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose()
  cache.clear()
}
