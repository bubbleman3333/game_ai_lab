// テトリスの操作設定（キー割り当て・DAS/ARR）。ブラウザに保存し、設定画面（pages/SettingsPage.tsx）で変えられる。
// 既定値は keyboard.ts の DEFAULT_KEYS / DEFAULT_HANDLING。

import { DEFAULT_HANDLING, DEFAULT_KEYS, type Handling, type KeyBindings } from './keyboard'

const KEYS_KEY = 'game-ai-lab:tetris:keys'
const HANDLING_KEY = 'game-ai-lab:tetris:handling'

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 保存できなくても、この画面の間は使える */
  }
}

export const loadKeys = (): KeyBindings => load(KEYS_KEY, DEFAULT_KEYS)
export const saveKeys = (k: KeyBindings) => save(KEYS_KEY, k)
export const loadHandling = (): Handling => load(HANDLING_KEY, DEFAULT_HANDLING)
export const saveHandling = (h: Handling) => save(HANDLING_KEY, h)

/** 操作の表示名（設定画面・操作説明で使う） */
export const ACTION_LABELS: Record<keyof KeyBindings, string> = {
  left: '左移動',
  right: '右移動',
  softDrop: 'ソフトドロップ',
  hardDrop: 'ハードドロップ',
  rotateCw: '右回転',
  rotateCcw: '左回転',
  hold: 'ホールド',
}

/** KeyboardEvent.code を読みやすい名前にする（'KeyA' → 'A'、'ArrowLeft' → '←'） */
export function keyLabel(code: string): string {
  const special: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space',
    ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  }
  if (special[code]) return special[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `テンキー${code.slice(6)}`
  return code
}
