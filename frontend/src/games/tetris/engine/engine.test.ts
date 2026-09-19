// Python 版エンジンと同じ結果になるかを shared/fixtures/engine_cases.json で確かめる。
// データの作り直し: cd backend; python -m tetris.fixtures

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Game, type Action, type LockResult } from './game'
import { BagRandomizer, Mulberry32 } from './rng'

const data = JSON.parse(
  readFileSync(new URL('../../../../../shared/fixtures/tetris/engine_cases.json', import.meta.url), 'utf-8'),
)

// Python の snake_case に合わせる
const toPyLock = (r: LockResult) => ({
  piece: r.piece, lines: r.lines, spin: r.spin, attack: r.attack, sent: r.sent, combo: r.combo,
  b2b: r.b2b, b2b_bonus: r.b2bBonus, perfect_clear: r.perfectClear,
  garbage_received: r.garbageReceived, game_over: r.gameOver,
})

describe('engine matches Python', () => {
  it('rng', () => {
    const r = new Mulberry32(data.rng.seed)
    for (const v of data.rng.values) expect(r.nextFloat()).toBe(v)
  })

  it('7-bag', () => {
    const b = new BagRandomizer(data.bags.seed)
    expect([...b.nextBag(), ...b.nextBag(), ...b.nextBag()]).toEqual(data.bags.pieces)
  })

  it('T-Spin Double', () => {
    const c = data.tspin_double
    const g = new Game(1)
    c.setup_rows.forEach((r: number, i: number) => (g.board.rows[i] = r))
    g.forceCurrent('T')
    let last: LockResult | null = null
    for (const a of c.actions as Action[]) {
      const r = g.apply(a)
      if (a === 'HD') last = r as LockResult
    }
    expect(toPyLock(last!)).toEqual(c.lock)
    expect(g.board.rows).toEqual(c.final_rows)
  })

  for (const c of data.random_games) {
    it(`random game seed=${c.seed}`, () => {
      const g = new Game(c.seed)
      const locks: object[] = []
      ;(c.actions as Action[]).forEach((a, i) => {
        if (c.garbage[String(i)] !== undefined) g.receiveGarbage(c.garbage[String(i)])
        const r = g.apply(a)
        if (a === 'HD') locks.push(toPyLock(r as LockResult))
      })
      expect(locks).toEqual(c.locks)
      const f = c.final
      expect(g.board.rows).toEqual(f.rows)
      expect(g.hold).toBe(f.hold)
      expect(g.nextPieces).toEqual(f.next)
      expect(g.pending).toEqual(f.pending)
      expect(g.over).toBe(f.over)
      expect(g.current ? { ...g.current } : null).toEqual(f.current)
    })
  }
})
