// T-Spin 判定・火力計算・固定処理。backend/tetris/rules.py と lock.py と同じ。

import { Board } from './board'
import { T_ALL_CORNERS, T_FRONT_CORNERS, type PieceType, type Rotation } from './pieces'

export type Spin = 'none' | 'mini' | 'full'
/** [段数, 穴の列] */
export type PendingGarbage = [number, number]

export const GARBAGE_CAP_PER_LOCK = 8
export const PERFECT_CLEAR_BONUS = 10
export const COMBO_TABLE = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5]
const NORMAL_ATTACK = [0, 0, 1, 2, 4]
const TSPIN_ATTACK = [0, 2, 4, 6]
const MINI_ATTACK = [0, 0, 1]

export function detectSpin(
  board: Board, piece: PieceType, rot: Rotation, x: number, y: number, lastKick: number | null,
): Spin {
  if (piece !== 'T' || lastKick === null) return 'none'
  const filled = T_ALL_CORNERS.filter(([dx, dy]) => board.isFilled(x + dx, y + dy)).length
  if (filled < 3) return 'none'
  const front = T_FRONT_CORNERS[rot].filter(([dx, dy]) => board.isFilled(x + dx, y + dy)).length
  return front === 2 || lastKick === 4 ? 'full' : 'mini'
}

export interface AttackResult {
  attack: number
  combo: number
  b2b: boolean
  b2bBonus: boolean
}

export function computeAttack(lines: number, spin: Spin, combo: number, b2b: boolean, perfect: boolean): AttackResult {
  if (lines === 0) return { attack: 0, combo: -1, b2b, b2bBonus: false }
  let base: number
  if (spin === 'full') base = TSPIN_ATTACK[Math.min(lines, 3)]
  else if (spin === 'mini') base = MINI_ATTACK[Math.min(lines, 2)]
  else base = NORMAL_ATTACK[lines]
  const difficult = lines === 4 || spin !== 'none'
  const b2bBonus = difficult && b2b
  const newCombo = combo + 1
  let attack = base + (b2bBonus ? 1 : 0) + COMBO_TABLE[Math.min(newCombo, COMBO_TABLE.length - 1)]
  if (perfect) attack += PERFECT_CLEAR_BONUS
  return { attack, combo: newCombo, b2b: difficult, b2bBonus }
}

/** 火力で予告を相殺する。元の配列は変更しない */
export function cancelGarbage(pending: readonly PendingGarbage[], attack: number): [PendingGarbage[], number] {
  const remaining = pending.map((p) => [p[0], p[1]] as PendingGarbage)
  while (attack > 0 && remaining.length) {
    const take = Math.min(attack, remaining[0][0])
    remaining[0][0] -= take
    attack -= take
    if (remaining[0][0] === 0) remaining.shift()
  }
  return [remaining, attack]
}

/** 予告を最大 GARBAGE_CAP_PER_LOCK 段まで入れる（board を直接変更） */
export function applyPendingGarbage(board: Board, pending: readonly PendingGarbage[]): [PendingGarbage[], number, boolean] {
  const remaining = pending.map((p) => [p[0], p[1]] as PendingGarbage)
  let received = 0
  while (remaining.length && received < GARBAGE_CAP_PER_LOCK) {
    const [amount, hole] = remaining[0]
    const n = Math.min(amount, GARBAGE_CAP_PER_LOCK - received)
    received += n
    if (n === amount) remaining.shift()
    else remaining[0][0] -= n
    if (!board.addGarbage(n, hole)) return [remaining, received, true]
  }
  return [remaining, received, false]
}

export interface LockOutcome {
  board: Board
  lines: number
  attack: number
  sent: number
  combo: number
  b2b: boolean
  b2bBonus: boolean
  perfectClear: boolean
  pending: PendingGarbage[]
  garbageReceived: number
  dead: boolean
}

export function resolveLock(
  board: Board, piece: PieceType, rot: Rotation, x: number, y: number, spin: Spin,
  combo: number, b2b: boolean, pending: readonly PendingGarbage[],
): LockOutcome {
  const b = board.copy()
  b.place(piece, rot, x, y)
  const lines = b.clearLines()
  const perfect = lines > 0 && b.isEmpty()
  const atk = computeAttack(lines, spin, combo, b2b, perfect)
  let [remaining, sent] = cancelGarbage(pending, atk.attack)
  let received = 0
  let topOut = false
  if (lines === 0) [remaining, received, topOut] = applyPendingGarbage(b, remaining)
  return {
    board: b, lines, attack: atk.attack, sent, combo: atk.combo, b2b: atk.b2b, b2bBonus: atk.b2bBonus,
    perfectClear: perfect, pending: remaining, garbageReceived: received, dead: topOut,
  }
}
