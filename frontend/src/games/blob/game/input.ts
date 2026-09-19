// ブロブチェインのキー操作（押しっぱなしの連続移動つき）とスマホのボタン。
// ← → 移動 / ↓ 下へ / Z・X・↑ 回転 / Space すぐ落とす

import type { BlobController } from '../engine/controller'

const DAS_MS = 150
const ARR_MS = 45
const SOFT_MS = 35

type Key = 'left' | 'right' | 'down' | 'cw' | 'ccw' | 'drop'

const KEYS: Record<string, Key> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
  KeyX: 'cw', ArrowUp: 'cw', KeyZ: 'ccw', ControlLeft: 'ccw', Space: 'drop',
}

export const KEY_HELP = '← → 移動 / ↓ 下へ / X・↑ 右回転 / Z 左回転 / Space すぐ落とす'

export class BlobInput {
  private c: BlobController
  private held = new Set<Key>()
  private dir: 'left' | 'right' | null = null
  private since = 0
  private lastRepeat = 0
  private lastSoft = 0

  constructor(c: BlobController) {
    this.c = c
  }

  press(k: Key): void {
    if (this.held.has(k)) return
    this.held.add(k)
    const now = performance.now()
    if (k === 'left' || k === 'right') {
      this.c.move(k === 'left' ? -1 : 1)
      this.dir = k
      this.since = now
      this.lastRepeat = now
    } else if (k === 'down') {
      this.c.softDrop()
      this.lastSoft = now
    } else if (k === 'cw') this.c.rotate(1)
    else if (k === 'ccw') this.c.rotate(-1)
    else if (k === 'drop') this.c.hardDrop()
  }

  release(k: Key): void {
    this.held.delete(k)
    if (k === this.dir) {
      this.dir = this.held.has('left') ? 'left' : this.held.has('right') ? 'right' : null
      this.since = this.lastRepeat = performance.now()
    }
  }

  attach(): () => void {
    const down = (e: KeyboardEvent) => {
      const k = KEYS[e.code]
      if (!k) return
      e.preventDefault()
      if (!e.repeat) this.press(k)
    }
    const up = (e: KeyboardEvent) => {
      const k = KEYS[e.code]
      if (k) this.release(k)
    }
    const blur = () => {
      this.held.clear()
      this.dir = null
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }

  update(now: number): void {
    if (this.dir && now - this.since >= DAS_MS) {
      while (now - this.lastRepeat >= ARR_MS) {
        this.lastRepeat += ARR_MS
        if (!this.c.move(this.dir === 'left' ? -1 : 1)) {
          this.lastRepeat = now
          break
        }
      }
    }
    if (this.held.has('down') && now - this.lastSoft >= SOFT_MS) {
      this.lastSoft = now
      this.c.softDrop()
    }
  }
}

export type { Key as BlobKey }
