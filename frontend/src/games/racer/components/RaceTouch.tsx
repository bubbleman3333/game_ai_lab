// スマホ用の操作ボタン。押しているあいだだけ入力が入る（キーボードと同じ扱い）。

import type { Action, RaceInput } from '../game/input'

interface Props { input: RaceInput }

const hold = (input: RaceInput, a: Action) => ({
  onPointerDown: (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    input.press(a)
  },
  onPointerUp: () => input.release(a),
  onPointerCancel: () => input.release(a),
  onPointerLeave: () => input.release(a),
})

export function RaceTouch({ input }: Props) {
  return (
    <div className="racer-touch">
      <div className="racer-touch-left">
        <button type="button" {...hold(input, 'left')} aria-label="左">◀</button>
        <button type="button" {...hold(input, 'right')} aria-label="右">▶</button>
      </div>
      <div className="racer-touch-right">
        <button type="button" {...hold(input, 'jump')} aria-label="ジャンプ">跳</button>
        <button type="button" {...hold(input, 'brake')} aria-label="ブレーキ">B</button>
        <button type="button" className="big" {...hold(input, 'accel')} aria-label="アクセル">A</button>
      </div>
    </div>
  )
}
