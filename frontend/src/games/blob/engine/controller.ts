// 時間の進行（落下・接地・連鎖のアニメーション・おじゃまの落下）を BlobGame にかぶせる。React には依存しない。
// 毎フレーム update(now) を呼ぶ。描画側は phase と anim を見て、はじける・落ちる動きを描く。

import { BlobGame, type PopStep } from './game'

export type Phase = 'play' | 'settle' | 'pop' | 'garbage' | 'over'

export type BlobEvent =
  | { type: 'move' }
  | { type: 'rotate' }
  | { type: 'lock' }
  | { type: 'pop'; step: PopStep }
  | { type: 'chainEnd'; chain: number }
  | { type: 'allClear' }
  | { type: 'garbage'; count: number }
  | { type: 'over' }

export interface Anim {
  start: number
  duration: number
  /** 落ちる粒: [x, 元の y, 新しい y] */
  moved?: [number, number, number][]
  /** はじける粒 */
  popped?: { i: number; color: number }[]
  chain?: number
}

const SETTLE_MS = 160
const POP_MS = 420
const GARBAGE_MS = 380
const LOCK_DELAY_MS = 450

export class BlobController {
  readonly game: BlobGame
  phase: Phase = 'play'
  anim: Anim | null = null
  paused = false
  /** 状態が変わるたびに増える（React の再描画用） */
  version = 0
  /** 1 マス落ちるまでの時間。レベルが上がると短くなる */
  gravityMs = 700
  /** 次の 1 マス落下までの進み具合（0〜1。なめらかに描くため） */
  fallProgress = 0

  private lastFall = 0
  private groundedAt: number | null = null
  private listeners: ((e: BlobEvent) => void)[] = []
  private chainHappened = false

  constructor(game: BlobGame) {
    this.game = game
  }

  on(fn: (e: BlobEvent) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn)
    }
  }

  private emit(e: BlobEvent): void {
    for (const l of this.listeners) l(e)
    this.version++
  }

  // --- 操作（play 中だけ） ---------------------------------------------------------------
  move(dx: number): boolean {
    if (!this.canAct() || !this.game.move(dx)) return false
    this.bumpLock()
    this.emit({ type: 'move' })
    return true
  }

  rotate(dir: 1 | -1): boolean {
    if (!this.canAct() || !this.game.rotate(dir)) return false
    this.bumpLock()
    this.emit({ type: 'rotate' })
    return true
  }

  softDrop(): boolean {
    if (!this.canAct()) return false
    if (this.game.softDrop()) {
      this.game.score += 1
      this.lastFall = performance.now()
      this.version++
      return true
    }
    this.lockNow(performance.now())
    return false
  }

  hardDrop(): void {
    if (!this.canAct()) return
    let n = 0
    while (this.game.softDrop()) n++
    this.game.score += n * 2
    this.lockNow(performance.now())
  }

  receiveGarbage(n: number): void {
    this.game.receiveGarbage(n)
    this.version++
  }

  private canAct(): boolean {
    return !this.paused && this.phase === 'play' && !!this.game.current
  }

  private bumpLock(): void {
    // 接地中に動かしたら、固定までの時間を少し延ばす（動かし続けて止まるのは防ぐため 1 回分だけ）
    if (this.groundedAt !== null) this.groundedAt = Math.max(this.groundedAt, performance.now() - LOCK_DELAY_MS / 2)
  }

  // --- 時間の進行 ---------------------------------------------------------------------
  update(now: number): void {
    if (this.paused || this.phase === 'over') return
    if (this.lastFall === 0) this.lastFall = now

    if (this.phase === 'play') {
      const g = this.game
      if (!g.current) return
      if (g.isGrounded()) {
        this.fallProgress = 0
        if (this.groundedAt === null) this.groundedAt = now
        if (now - this.groundedAt >= LOCK_DELAY_MS) this.lockNow(now)
        return
      }
      this.groundedAt = null
      this.fallProgress = Math.min(1, (now - this.lastFall) / this.gravityMs)
      if (now - this.lastFall >= this.gravityMs) {
        this.lastFall = now
        this.fallProgress = 0
        g.softDrop()
        this.version++
      }
      return
    }

    // アニメーション中
    if (this.anim && now - this.anim.start < this.anim.duration) return
    if (this.phase === 'settle') this.checkPops(now)
    else if (this.phase === 'pop') {
      const { moved, allClear } = this.game.settle()
      if (allClear) this.emit({ type: 'allClear' })
      this.startAnim('settle', now, SETTLE_MS, { moved })
    } else if (this.phase === 'garbage') this.spawn(now)
  }

  private lockNow(now: number): void {
    const moved = this.game.lock()
    this.groundedAt = null
    this.chainHappened = false
    this.emit({ type: 'lock' })
    this.startAnim('settle', now, moved.length ? SETTLE_MS : 0, { moved })
  }

  private checkPops(now: number): void {
    const step = this.game.popStep()
    if (step) {
      this.chainHappened = true
      this.emit({ type: 'pop', step })
      this.startAnim('pop', now, POP_MS, { popped: step.cells, chain: step.chain })
      return
    }
    if (this.chainHappened) this.emit({ type: 'chainEnd', chain: this.game.chain })
    // 連鎖が終わったら、残っている予告のおじゃまを降らせる
    const placed = this.game.dropGarbage()
    if (placed.length) {
      this.emit({ type: 'garbage', count: placed.length })
      this.startAnim('garbage', now, GARBAGE_MS, {
        moved: placed.map((i) => [i % 6, 13, Math.floor(i / 6)] as [number, number, number]),
      })
      return
    }
    this.spawn(now)
  }

  private spawn(now: number): void {
    this.anim = null
    if (!this.game.spawn()) {
      this.phase = 'over'
      this.emit({ type: 'over' })
      return
    }
    this.phase = 'play'
    this.lastFall = now
    this.version++
  }

  private startAnim(phase: Phase, now: number, duration: number, a: Omit<Anim, 'start' | 'duration'>): void {
    this.phase = phase
    this.anim = { start: now, duration, ...a }
    this.version++
  }
}
