// スマホ用の操作ボタン。押しているあいだだけ入力が入る（キーボードと同じ扱い）。

import type { Action, CityInput } from '../input'

const hold = (input: CityInput, a: Action) => ({
  onPointerDown: (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    input.press(a)
  },
  onPointerUp: () => input.release(a),
  onPointerCancel: () => input.release(a),
  onPointerLeave: () => input.release(a),
})

export function CityTouch({ input }: { input: CityInput }) {
  return (
    <div className="city-touch">
      <div>
        <button type="button" {...hold(input, 'left')} aria-label="左">◀</button>
        <button type="button" {...hold(input, 'right')} aria-label="右">▶</button>
      </div>
      <div>
        <button type="button" className="small" {...hold(input, 'carjack')} aria-label="車を奪う">奪</button>
        <button type="button" className="small" {...hold(input, 'horn')} aria-label="クラクション">📯</button>
        <button type="button" {...hold(input, 'handbrake')} aria-label="サイドブレーキ">SB</button>
        <button type="button" {...hold(input, 'brake')} aria-label="ブレーキ">B</button>
        <button type="button" className="big" {...hold(input, 'accel')} aria-label="アクセル">A</button>
      </div>
    </div>
  )
}
