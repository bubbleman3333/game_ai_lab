// requestAnimationFrame で毎フレーム update を呼び、状態が変わったら React を再描画するフック。

import { useEffect, useReducer, useRef } from 'react'
import { flushSync } from 'react-dom'

export interface Updatable {
  update(now: number): void
}

/**
 * @param items 毎フレーム update(now) を呼ぶもの（GameController の tick は tickers に）
 * @param version 状態の版数を返す関数。値が変わったときだけ再描画する
 */
export function useGameLoop(
  items: Updatable[],
  tickers: { tick(now: number): void }[],
  version: () => number | string,
): void {
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const ref = useRef({ items, tickers, version })
  ref.current = { items, tickers, version }

  useEffect(() => {
    let raf = 0
    let last: number | string = -1
    const loop = (now: number) => {
      const { items, tickers, version } = ref.current
      for (const t of tickers) t.tick(now)
      for (const i of items) i.update(now)
      const v = version()
      if (v !== last) {
        last = v
        // flushSync で「このフレームのうちに」描き直す。普通の rerender() だと React が後回しにして
        // 画面に出るのが 1〜2 フレーム遅れ、キーを押してから動くまでがもたつく
        flushSync(rerender)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
}
