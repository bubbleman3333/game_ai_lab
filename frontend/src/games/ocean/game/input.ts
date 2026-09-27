// キーボードとスマホのボタンから、泳ぐ人への入力（sim/game.ts の Input）を作る。
//
// 左右・潜る・ダッシュは「押しているあいだ」効き、蹴るは「押した瞬間」だけ効く。

import type { Input } from '../sim/game'

export type Action = 'left' | 'right' | 'dive' | 'dash' | 'kick'

const KEY_MAP: Record<string, Action> = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'dive', KeyS: 'dive',
  ArrowUp: 'dash', KeyW: 'dash', ShiftLeft: 'dash', ShiftRight: 'dash',
  Space: 'kick', KeyK: 'kick', Enter: 'kick',
}

export class OceanInput {
  private held = new Set<Action>()
  private kickQueued = false

  /** キーボードの購読を始める。戻り値を呼ぶと購読をやめる */
  attach(target: Window | HTMLElement = window): () => void {
    const down = (e: Event) => {
      const a = KEY_MAP[(e as KeyboardEvent).code]
      if (!a) return
      e.preventDefault()
      if (a === 'kick') {
        if (!(e as KeyboardEvent).repeat) this.kickQueued = true
      } else {
        this.held.add(a)
      }
    }
    const up = (e: Event) => {
      const a = KEY_MAP[(e as KeyboardEvent).code]
      if (!a) return
      e.preventDefault()
      this.held.delete(a)
    }
    const blur = () => this.held.clear()
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }

  /** スマホのボタン用 */
  press(a: Action): void {
    if (a === 'kick') this.kickQueued = true
    else this.held.add(a)
  }
  release(a: Action): void { this.held.delete(a) }
  isHeld(a: Action): boolean { return this.held.has(a) }
  clear(): void { this.held.clear(); this.kickQueued = false }

  /** 今の入力を読む。蹴りは 1 回読むと消える */
  read(): Input {
    const kick = this.kickQueued
    this.kickQueued = false
    return {
      steer: (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0),
      dive: this.held.has('dive'),
      dash: this.held.has('dash'),
      kick,
    }
  }
}
