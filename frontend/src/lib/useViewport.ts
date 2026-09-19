// 画面の幅に合わせた大きさを決めるためのフック（スマホ対応）。

import { useEffect, useState } from 'react'

export function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth))
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** 指で操作する端末か（スマホ・タブレット） */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

/** テトリスの 1 マスの大きさ。boards: 横に並べる盤の数 */
export function useTetrisCell(boards: number, max: number): number {
  const w = useViewportWidth()
  // 盤 1 つの横幅 ≒ 10 マス + 左右の表示（ホールド・ネクスト・予告）で約 5.5 マス分
  const perBoard = (w - 32) / boards
  return Math.max(10, Math.min(max, Math.floor(perBoard / 15.5)))
}
