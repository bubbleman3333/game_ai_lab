// キーボード操作（DAS / ARR / ソフトドロップの連続入力）。React には依存しない。
// 使い方: const k = new KeyboardInput(controller); k.attach(); 毎フレーム k.update(now)

import type { Action, GameController } from '../engine'

export interface KeyBindings {
  left: string[]
  right: string[]
  softDrop: string[]
  hardDrop: string[]
  rotateCw: string[]
  rotateCcw: string[]
  hold: string[]
}

/** KeyboardEvent.code で指定する */
export const DEFAULT_KEYS: KeyBindings = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['Space'],
  rotateCw: ['ArrowUp', 'KeyA'],
  rotateCcw: ['KeyS', 'ControlLeft'],
  hold: ['KeyF', 'ShiftLeft'],
}

export interface Handling {
  /** 押しっぱなしで連続移動が始まるまで（ms） */
  dasMs: number
  /** 連続移動の間隔（ms）。0 なら壁まで一気に移動 */
  arrMs: number
  /** ソフトドロップで 1 マス落ちる間隔（ms）。0 なら一気に床まで */
  softDropMs: number
}

export const DEFAULT_HANDLING: Handling = { dasMs: 133, arrMs: 10, softDropMs: 20 }

type Dir = 'L' | 'R'

export class KeyboardInput {
  private controller: GameController
  private keys: KeyBindings
  handling: Handling
  enabled = true

  private held = new Set<string>()
  private dir: Dir | null = null
  private dirSince = 0
  private lastRepeat = 0
  private softDropping = false
  private lastSoftDrop = 0

  constructor(controller: GameController, keys: KeyBindings = DEFAULT_KEYS, handling: Handling = DEFAULT_HANDLING) {
    this.controller = controller
    this.keys = keys
    this.handling = handling
  }

  attach(target: Window = window): () => void {
    const down = (e: KeyboardEvent) => this.onDown(e)
    const up = (e: KeyboardEvent) => this.onUp(e)
    const blur = () => this.releaseAll()
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    target.addEventListener('blur', blur)
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      target.removeEventListener('blur', blur)
    }
  }

  private match(code: string): keyof KeyBindings | null {
    for (const k of Object.keys(this.keys) as (keyof KeyBindings)[]) {
      if (this.keys[k].includes(code)) return k
    }
    return null
  }

  private onDown(e: KeyboardEvent): void {
    const name = this.match(e.code)
    if (!name) return
    e.preventDefault()
    if (e.repeat || !this.enabled) return
    this.held.add(name)
    const now = performance.now()
    const act = (a: Action) => this.controller.act(a, now)
    switch (name) {
      case 'left':
      case 'right': {
        const d: Dir = name === 'left' ? 'L' : 'R'
        act(d)
        this.startDas(d, now)
        break
      }
      case 'softDrop':
        this.softDropping = true
        this.lastSoftDrop = now
        act(this.handling.softDropMs <= 0 ? 'SDB' : 'SD')
        break
      case 'hardDrop':
        act('HD')
        break
      case 'rotateCw':
        act('CW')
        break
      case 'rotateCcw':
        act('CCW')
        break
      case 'hold':
        act('HOLD')
        break
    }
  }

  private onUp(e: KeyboardEvent): void {
    const name = this.match(e.code)
    if (!name) return
    this.held.delete(name)
    if (name === 'softDrop') this.softDropping = false
    if ((name === 'left' && this.dir === 'L') || (name === 'right' && this.dir === 'R')) {
      // 反対側がまだ押されていればそちらに切り替える
      const other: Dir | null = this.held.has('left') ? 'L' : this.held.has('right') ? 'R' : null
      this.startDas(other, performance.now())
    }
  }

  /** 押しっぱなしの計測を始める。連続移動は DAS が切れた時点から数える
   * （押した時点から数えると、DAS が切れた瞬間に DAS の時間分をまとめて動かしてしまい、急に大きく飛ぶ） */
  private startDas(dir: Dir | null, now: number): void {
    this.dir = dir
    this.dirSince = now
    this.lastRepeat = now + this.handling.dasMs - this.handling.arrMs
  }

  private releaseAll(): void {
    this.held.clear()
    this.dir = null
    this.softDropping = false
  }

  /** 毎フレーム呼ぶ（押しっぱなしの処理） */
  update(now: number): void {
    if (!this.enabled) return
    const h = this.handling
    if (this.dir && now - this.dirSince >= h.dasMs) {
      if (h.arrMs <= 0) {
        while (this.controller.act(this.dir, now)) { /* 壁まで */ }
      } else {
        while (now - this.lastRepeat >= h.arrMs) {
          this.lastRepeat += h.arrMs
          if (!this.controller.act(this.dir, now)) {
            this.lastRepeat = now
            break
          }
        }
      }
    }
    if (this.softDropping) {
      if (h.softDropMs <= 0) this.controller.act('SDB', now)
      else {
        while (now - this.lastSoftDrop >= h.softDropMs) {
          this.lastSoftDrop += h.softDropMs
          if (!this.controller.act('SD', now)) {
            this.lastSoftDrop = now
            break
          }
        }
      }
    }
  }
}
