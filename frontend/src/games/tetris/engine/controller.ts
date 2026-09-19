// 時間に関わる処理（重力・ロック遅延）を Game にかぶせる。React には依存しない。
// 使い方: const c = new GameController(game, opts); 毎フレーム c.tick(now) を呼ぶ。

import { Game, type Action, type LockResult } from './game'

export interface ControllerOptions {
  /** 1 マス落ちるまでの時間（ms）。0 以下なら重力なし（AI 用） */
  gravityMs: number
  /** 接地してから固定されるまでの時間（ms） */
  lockDelayMs: number
  /** 接地中の移動・回転でロック遅延をリセットできる回数 */
  maxLockResets: number
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
  gravityMs: 1000,
  lockDelayMs: 500,
  maxLockResets: 15,
}

export type LockListener = (result: LockResult, controller: GameController) => void
/** 操作が成功したときに呼ばれる（効果音などに使う）。HD は onLock で受け取る */
export type ActionListener = (action: Action, controller: GameController) => void

export class GameController {
  readonly game: Game
  opts: ControllerOptions
  /** 状態が変わるたびに増える。React の再描画のきっかけに使う */
  version = 0
  lastLock: LockResult | null = null
  paused = false
  /** 実際に遊んでいた時間（ms。一時停止中・ゲームオーバー後は数えない）。APM・PPS の計算に使う */
  playMs = 0
  private lastTickAt: number | null = null

  private lastGravityAt = 0
  private groundedAt: number | null = null
  private lockResets = 0
  private listeners: LockListener[] = []
  private actionListeners: ActionListener[] = []

  constructor(game: Game, opts: Partial<ControllerOptions> = {}) {
    this.game = game
    this.opts = { ...DEFAULT_CONTROLLER_OPTIONS, ...opts }
  }

  onLock(fn: LockListener): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }

  onAction(fn: ActionListener): () => void {
    this.actionListeners.push(fn)
    return () => {
      this.actionListeners = this.actionListeners.filter((l) => l !== fn)
    }
  }

  /** 毎フレーム呼ぶ。重力とロック遅延を進める */
  tick(now: number): void {
    const g = this.game
    if (this.paused || g.over || !g.current) {
      this.lastTickAt = null
      return
    }
    if (this.lastTickAt !== null) this.playMs += Math.min(1000, now - this.lastTickAt)
    this.lastTickAt = now
    if (this.lastGravityAt === 0) this.lastGravityAt = now

    if (this.opts.gravityMs > 0) {
      while (now - this.lastGravityAt >= this.opts.gravityMs) {
        this.lastGravityAt += this.opts.gravityMs
        if (g.softDrop()) this.changed()
      }
    } else {
      this.lastGravityAt = now
    }

    if (this.opts.gravityMs > 0 && g.isGrounded()) {
      if (this.groundedAt === null) this.groundedAt = now
      if (now - this.groundedAt >= this.opts.lockDelayMs) this.lock()
    } else {
      this.groundedAt = null
    }
  }

  /** プレイヤー・AI の操作。戻り値は操作が成功したか */
  act(action: Action, now = performance.now()): boolean {
    const g = this.game
    if (this.paused || g.over) return false
    if (action === 'HD') {
      this.lock()
      return true
    }
    const wasGrounded = g.isGrounded()
    const r = g.apply(action)
    const ok = typeof r === 'number' ? r > 0 : r === true
    if (!ok) return false
    if (action === 'HOLD') this.resetTimers(now)
    else if (wasGrounded || g.isGrounded()) this.bumpLockDelay(now)
    if (action === 'SD' || action === 'SDB') this.lastGravityAt = now
    this.changed()
    for (const l of this.actionListeners) l(action, this)
    return true
  }

  receiveGarbage(lines: number): void {
    this.game.receiveGarbage(lines)
    this.changed()
  }

  private bumpLockDelay(now: number): void {
    if (this.groundedAt === null) return
    if (this.lockResets < this.opts.maxLockResets) {
      this.lockResets++
      this.groundedAt = now
    }
  }

  private resetTimers(now: number): void {
    this.groundedAt = null
    this.lockResets = 0
    this.lastGravityAt = now
  }

  private lock(): void {
    const result = this.game.hardDrop()
    this.lastLock = result
    this.resetTimers(performance.now())
    this.changed()
    for (const l of this.listeners) l(result, this)
  }

  private changed(): void {
    this.version++
  }
}
