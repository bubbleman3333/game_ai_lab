// スマホ用の操作ボタン。押すと、キー設定で割り当てたキーを押したのと同じ扱いになる
// （keyboard.ts の DAS/ARR・ソフトドロップの連続入力がそのまま効く）。

import { loadKeys } from '../game/settings'
import type { KeyBindings } from '../game/keyboard'

const BUTTONS: { action: keyof KeyBindings; label: string; wide?: boolean }[] = [
  { action: 'hold', label: 'HOLD' },
  { action: 'rotateCcw', label: '⟲' },
  { action: 'rotateCw', label: '⟳' },
  { action: 'left', label: '←' },
  { action: 'softDrop', label: '↓' },
  { action: 'right', label: '→' },
  { action: 'hardDrop', label: 'ドロップ', wide: true },
]

function send(type: 'keydown' | 'keyup', code: string) {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }))
}

export function TouchControls() {
  const keys = loadKeys()
  return (
    <div className="touch-controls" onContextMenu={(e) => e.preventDefault()}>
      {BUTTONS.map((b) => {
        const code = keys[b.action][0]
        if (!code) return null
        return (
          <button
            key={b.action}
            className={`touch-btn${b.wide ? ' wide' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              send('keydown', code)
            }}
            onPointerUp={() => send('keyup', code)}
            onPointerCancel={() => send('keyup', code)}
          >
            {b.label}
          </button>
        )
      })}
    </div>
  )
}
