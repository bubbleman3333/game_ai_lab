// スマホ用の操作ボタン（押しっぱなしで連続移動・連続落下も効く）。

import type { BlobInput, BlobKey } from '../game/input'

const BUTTONS: { key: BlobKey; label: string; wide?: boolean }[] = [
  { key: 'ccw', label: '⟲' },
  { key: 'drop', label: '▼▼' },
  { key: 'cw', label: '⟳' },
  { key: 'left', label: '←' },
  { key: 'down', label: '↓' },
  { key: 'right', label: '→' },
]

export function BlobTouch({ input }: { input: BlobInput }) {
  return (
    <div className="touch-controls" onContextMenu={(e) => e.preventDefault()}>
      {BUTTONS.map((b) => (
        <button
          key={b.key}
          className="touch-btn"
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            input.press(b.key)
          }}
          onPointerUp={() => input.release(b.key)}
          onPointerCancel={() => input.release(b.key)}
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}
