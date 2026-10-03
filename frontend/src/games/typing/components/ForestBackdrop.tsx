// メニュー（タイトル・セーブ・拠点・結果）の後ろに置く夜の森。
// 戦いは無く、ゆっくり歩きながら遠くに影が漂う（ForestScene に game を渡さないとこうなる）。
// 章の色（themeId）が変わったら作り直す（呼び出し側で key={themeId} を付ける）。

import { useEffect, useRef } from 'react'
import { ForestScene } from '../scene/ForestScene'
import { NORMAL_SHAPES } from '../scene/shade'

export function ForestBackdrop({ themeId }: { themeId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let scene: ForestScene
    try {
      scene = new ForestScene(canvas, themeId)
    } catch (e) {
      // WebGL が使えなくても、メニューは暗い背景のまま使える
      console.error(e)
      return
    }
    // 確認用: URL の末尾に #shades を付けると、15 種類の影を並べて見せる
    if (window.location.hash === '#shades') scene.showGallery(NORMAL_SHAPES)
    const resize = () => scene.resize()
    window.addEventListener('resize', resize)
    resize()
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      scene.update(dt, null)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      scene.dispose()
    }
  }, [themeId])

  return <canvas ref={canvasRef} className="typing-backdrop" aria-hidden />
}
