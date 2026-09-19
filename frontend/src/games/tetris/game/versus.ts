// 同じ画面での対戦（人 vs AI など）。片方が火力を出したらもう片方におじゃまを送る。

import type { GameController } from '../engine'

/** a と b をつなぐ。戻り値を呼ぶと解除 */
export function linkGarbage(a: GameController, b: GameController): () => void {
  const offA = a.onLock((r) => {
    if (r.sent > 0 && !b.game.over) b.receiveGarbage(r.sent)
  })
  const offB = b.onLock((r) => {
    if (r.sent > 0 && !a.game.over) a.receiveGarbage(r.sent)
  })
  return () => {
    offA()
    offB()
  }
}

/** 「T-SPIN DOUBLE」「TETRIS」などの表示用ラベル */
export function clearLabel(r: { lines: number; spin: string; b2bBonus: boolean; combo: number; perfectClear: boolean }): string {
  const names = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS']
  const parts: string[] = []
  if (r.b2bBonus) parts.push('B2B')
  if (r.spin === 'full') parts.push(r.lines ? `T-SPIN ${names[r.lines]}` : 'T-SPIN')
  else if (r.spin === 'mini') parts.push(r.lines ? `T-SPIN MINI ${names[r.lines]}` : 'T-SPIN MINI')
  else if (r.lines) parts.push(names[r.lines])
  if (r.combo > 0) parts.push(`${r.combo} REN`)
  if (r.perfectClear) parts.push('PERFECT CLEAR')
  return parts.join(' ')
}
