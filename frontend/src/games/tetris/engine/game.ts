// 1 人分のゲーム状態と操作。時間（重力・ロック遅延）は controller.ts が扱う。
// backend/tetris/game.py と同じ動きをする（shared/fixtures で確認）。

import { Board } from './board'
import { kicks, SPAWN_X, SPAWN_Y, type PieceType, type Rotation } from './pieces'
import { BagRandomizer, Mulberry32 } from './rng'
import { detectSpin, resolveLock, type PendingGarbage, type Spin } from './rules'

export const GARBAGE_SEED_XOR = 0x9e3779b9
export type Action = 'L' | 'R' | 'CW' | 'CCW' | 'SD' | 'SDB' | 'HD' | 'HOLD'

export interface ActivePiece {
  type: PieceType
  rot: Rotation
  x: number
  y: number
}

export interface Stats {
  pieces: number
  lines: number
  attack: number
  sent: number
  tspinClears: number
  tetrises: number
  perfectClears: number
  maxCombo: number
}

export interface LockResult {
  piece: PieceType
  lines: number
  spin: Spin
  attack: number // 相殺前
  sent: number // 相殺後に相手へ送る段数
  combo: number
  b2b: boolean
  b2bBonus: boolean
  perfectClear: boolean
  garbageReceived: number
  gameOver: boolean
}

const emptyStats = (): Stats => ({
  pieces: 0, lines: 0, attack: 0, sent: 0, tspinClears: 0, tetrises: 0, perfectClears: 0, maxCombo: 0,
})

export class Game {
  readonly seed: number
  readonly queueSize: number
  board = new Board()
  queue: PieceType[] = []
  current: ActivePiece | null = null
  hold: PieceType | null = null
  canHold = true
  combo = -1
  b2b = false
  pending: PendingGarbage[] = []
  over = false
  stats: Stats = emptyStats()
  /** 最後に成功した操作が回転なら kick 番号、そうでなければ null（T-Spin 判定用） */
  lastKick: number | null = null

  private bag: BagRandomizer
  private garbageRng: Mulberry32

  constructor(seed = 0, queueSize = 5) {
    this.seed = seed
    this.queueSize = queueSize
    this.bag = new BagRandomizer(seed)
    this.garbageRng = new Mulberry32((seed ^ GARBAGE_SEED_XOR) >>> 0)
    this.fillQueue()
    this.spawn(this.takeNext())
  }

  get nextPieces(): PieceType[] {
    return this.queue.slice(0, this.queueSize)
  }

  // --- 内部処理 -------------------------------------------------------------
  private fillQueue(): void {
    while (this.queue.length < this.queueSize + 7) this.queue.push(...this.bag.nextBag())
  }

  private takeNext(): PieceType {
    const p = this.queue.shift()!
    this.fillQueue()
    return p
  }

  private spawn(piece: PieceType): void {
    this.current = { type: piece, rot: 0, x: SPAWN_X, y: SPAWN_Y }
    this.lastKick = null
    if (this.board.collides(piece, 0, SPAWN_X, SPAWN_Y)) this.over = true
  }

  private fits(rot: Rotation, x: number, y: number): boolean {
    return !this.board.collides(this.current!.type, rot, x, y)
  }

  // --- 操作 ---------------------------------------------------------------
  move(dx: number): boolean {
    const p = this.current
    if (this.over || !p || !this.fits(p.rot, p.x + dx, p.y)) return false
    p.x += dx
    this.lastKick = null
    return true
  }

  /** direction: +1 で右回転、-1 で左回転 */
  rotate(direction: 1 | -1): boolean {
    const p = this.current
    if (this.over || !p) return false
    const to = (((p.rot + direction) % 4) + 4) % 4 as Rotation
    const tests = kicks(p.type, p.rot, to)
    for (let i = 0; i < tests.length; i++) {
      const [kx, ky] = tests[i]
      if (this.fits(to, p.x + kx, p.y + ky)) {
        p.rot = to
        p.x += kx
        p.y += ky
        this.lastKick = i
        return true
      }
    }
    return false
  }

  softDrop(): boolean {
    const p = this.current
    if (this.over || !p || !this.fits(p.rot, p.x, p.y - 1)) return false
    p.y -= 1
    this.lastKick = null
    return true
  }

  softDropToBottom(): number {
    let n = 0
    while (this.softDrop()) n++
    return n
  }

  /** 接地しているか（ロック遅延の判定に使う） */
  isGrounded(): boolean {
    const p = this.current
    return !!p && !this.fits(p.rot, p.x, p.y - 1)
  }

  ghostY(): number {
    const p = this.current!
    let y = p.y
    while (this.fits(p.rot, p.x, y - 1)) y--
    return y
  }

  holdPiece(): boolean {
    if (this.over || !this.canHold || !this.current) return false
    const held = this.hold
    this.hold = this.current.type
    this.spawn(held ?? this.takeNext())
    this.canHold = false
    return true
  }

  hardDrop(): LockResult {
    if (this.over || !this.current) throw new Error('hardDrop はゲーム中にだけ呼べる')
    this.softDropToBottom()
    return this.lock()
  }

  /** 相手からの攻撃を予告に積む。穴の列はここで決める */
  receiveGarbage(lines: number): void {
    if (lines > 0) this.pending.push([lines, this.garbageRng.nextInt(10)])
  }

  /** 操作中のミノを差し替える（テスト用） */
  forceCurrent(piece: PieceType): void {
    this.spawn(piece)
  }

  /** 操作名で操作する（リプレイ・AI の経路再生用） */
  apply(action: Action): LockResult | boolean | number {
    switch (action) {
      case 'L': return this.move(-1)
      case 'R': return this.move(1)
      case 'CW': return this.rotate(1)
      case 'CCW': return this.rotate(-1)
      case 'SD': return this.softDrop()
      case 'SDB': return this.softDropToBottom()
      case 'HD': return this.hardDrop()
      case 'HOLD': return this.holdPiece()
    }
  }

  // --- 固定 ---------------------------------------------------------------
  private lock(): LockResult {
    const p = this.current!
    const spin = detectSpin(this.board, p.type, p.rot, p.x, p.y, this.lastKick)
    const out = resolveLock(this.board, p.type, p.rot, p.x, p.y, spin, this.combo, this.b2b, this.pending)
    this.board = out.board
    this.combo = out.combo
    this.b2b = out.b2b
    this.pending = out.pending

    const s = this.stats
    s.pieces++
    s.lines += out.lines
    s.attack += out.attack
    s.sent += out.sent
    if (out.lines && spin !== 'none') s.tspinClears++
    if (out.lines === 4) s.tetrises++
    if (out.perfectClear) s.perfectClears++
    s.maxCombo = Math.max(s.maxCombo, this.combo)

    this.canHold = true
    this.over = out.dead
    if (!this.over) this.spawn(this.takeNext())
    if (this.over) this.current = null

    return {
      piece: p.type, lines: out.lines, spin, attack: out.attack, sent: out.sent, combo: out.combo,
      b2b: out.b2b, b2bBonus: out.b2bBonus, perfectClear: out.perfectClear,
      garbageReceived: out.garbageReceived, gameOver: this.over,
    }
  }
}
