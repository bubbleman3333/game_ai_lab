// キーボード・マウス・スマホのボタンから、ゲームへの入力（sim/game.ts の Input）を作る。
//
// 押しっぱなしで効くもの（アクセル・ハンドル）は「押されているキーの集合」を毎フレーム読む。
// 1 回だけ効くもの（車を奪う・カメラ切り替え）は「押された瞬間」だけ true にする。

import type { Input } from './sim/game'

export type Action = 'accel' | 'brake' | 'left' | 'right' | 'handbrake' | 'horn' | 'carjack' | 'camera'
  | 'lookback' | 'reset' | 'time' | 'map' | 'pause'

const KEY_MAP: Record<string, Action> = {
  ArrowUp: 'accel', KeyW: 'accel',
  ArrowDown: 'brake', KeyS: 'brake',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'handbrake',
  KeyH: 'horn', KeyE: 'horn',
  KeyF: 'carjack', Enter: 'carjack',
  KeyC: 'camera', KeyV: 'camera',
  KeyQ: 'lookback',
  KeyR: 'reset',
  KeyT: 'time',
  KeyM: 'map', Tab: 'map',
  Escape: 'pause', KeyP: 'pause',
}

const STEER_RATE = 3.2 // 1 秒で 0 から 1 まで切れる速さ
const STEER_RETURN = 5.5

export class CityInput {
  private held = new Set<Action>()
  private pressed = new Set<Action>()
  private steerValue = 0
  /** マウスでカメラを回した量（ドラッグ） */
  orbit = 0
  private dragging = false

  attach(canvas: HTMLElement): () => void {
    const down = (e: KeyboardEvent) => {
      const a = KEY_MAP[e.code]
      if (!a) return
      e.preventDefault()
      if (!this.held.has(a)) this.pressed.add(a)
      this.held.add(a)
    }
    const up = (e: KeyboardEvent) => {
      const a = KEY_MAP[e.code]
      if (!a) return
      e.preventDefault()
      this.held.delete(a)
    }
    const blur = () => this.held.clear()
    const md = (e: PointerEvent) => { if (e.pointerType === 'mouse') this.dragging = true }
    const mu = () => { this.dragging = false }
    const mm = (e: PointerEvent) => {
      if (this.dragging) this.orbit = Math.max(-Math.PI, Math.min(Math.PI, this.orbit - e.movementX * 0.006))
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    canvas.addEventListener('pointerdown', md)
    window.addEventListener('pointerup', mu)
    window.addEventListener('pointermove', mm)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      canvas.removeEventListener('pointerdown', md)
      window.removeEventListener('pointerup', mu)
      window.removeEventListener('pointermove', mm)
    }
  }

  press(a: Action): void { if (!this.held.has(a)) this.pressed.add(a); this.held.add(a) }
  release(a: Action): void { this.held.delete(a) }
  isHeld(a: Action): boolean { return this.held.has(a) }

  /** 押された瞬間だったか（読むと消える） */
  take(a: Action): boolean {
    const v = this.pressed.has(a)
    this.pressed.delete(a)
    return v
  }

  read(dt: number): Input {
    const want = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0)
    const rate = want === 0 || Math.sign(want) !== Math.sign(this.steerValue) ? STEER_RETURN : STEER_RATE
    const diff = want - this.steerValue
    this.steerValue += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt)
    // 手を離したら、カメラはゆっくり後ろへ戻る
    if (!this.dragging) this.orbit *= Math.exp(-dt * 1.5)
    const throttle = (this.held.has('accel') ? 1 : 0) - (this.held.has('brake') ? 1 : 0)
    return {
      throttle,
      steer: this.steerValue,
      handbrake: this.held.has('handbrake'),
      horn: this.held.has('horn'),
      carjack: this.take('carjack'),
      reset: this.take('reset'),
      timeSkip: this.take('time'),
    }
  }
}
