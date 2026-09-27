// スマホ用の操作ボタン。押しているあいだだけ入力が入る（キーボードと同じ扱い）。蹴るだけは押した瞬間。

import type { Action, OceanInput } from '../game/input'

interface Props { input: OceanInput }

const hold = (input: OceanInput, a: Action) => ({
  onPointerDown: (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    input.press(a)
  },
  onPointerUp: () => input.release(a),
  onPointerCancel: () => input.release(a),
  onPointerLeave: () => input.release(a),
})

export function OceanTouch({ input }: Props) {
  return (
    <div className="ocean-touch">
      <div>
        <button type="button" {...hold(input, 'left')} aria-label="左">◀</button>
        <button type="button" {...hold(input, 'right')} aria-label="右">▶</button>
      </div>
      <div>
        <button type="button" {...hold(input, 'dive')} aria-label="潜る">潜</button>
        <button type="button" {...hold(input, 'dash')} aria-label="ダッシュ">速</button>
        <button type="button" className="big" {...hold(input, 'kick')} aria-label="蹴る">蹴</button>
      </div>
    </div>
  )
}
