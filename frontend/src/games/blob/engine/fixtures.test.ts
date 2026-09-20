// Python 版エンジン（backend/games/blob/）と同じ結果になるかを
// shared/fixtures/blob/engine_cases.json で確かめる。
// テストデータの作り直し: cd backend; .\.venv\Scripts\python -m games.blob.fixtures

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BlobGame } from './game'
import { GARBAGE, H, Rng, VISIBLE_H, W } from './rules'

interface Turn {
  garbage: number
  actions: string[]
  chain: number
  score: number
  attack: number
  cancelled: number
  sent: number
  all_clear: boolean
  rows: string[]
  pending: number
}

interface Cases {
  size: { W: number; H: number; VISIBLE_H: number }
  rng: { seed: number; values: number[] }
  queues: { seed: number; pairs: [number, number][] }
  random_games: { seed: number; turns: Turn[]; final: { score: number; max_chain: number; over: boolean } }[]
  chain4: { setup: string[]; place: [number, number]; axis: number; child: number; chain: number; score: number; attack: number; sent: number; rows: string[] }
  garbage: { seed: number; received: number; first: number[]; second: number[]; rows: string[] }
}

const cases: Cases = JSON.parse(
  readFileSync(new URL('../../../../../shared/fixtures/blob/engine_cases.json', import.meta.url), 'utf-8'),
)

/** 盤面を下の行から 1 行 6 文字の文字列にする（Python 側の _rows と同じ形） */
function rowsOf(g: BlobGame): string[] {
  const out: string[] = []
  for (let y = 0; y < H; y++) {
    let s = ''
    for (let x = 0; x < W; x++) s += String(g.field.cells[y * W + x])
    out.push(s)
  }
  return out
}

/** 連鎖が止まるまで一気に処理する（Python 側の resolve() と同じ） */
function resolve(g: BlobGame) {
  const r = { chain: 0, score: 0, attack: 0, cancelled: 0, sent: 0, allClear: false }
  for (;;) {
    const step = g.popStep()
    if (!step) break
    r.chain = step.chain
    r.score += step.score
    r.attack += step.attack
    r.cancelled += step.cancelled
    r.sent += step.sent
    if (g.settle().allClear) r.allClear = true
  }
  return r
}

function apply(g: BlobGame, action: string): void {
  if (action === 'L') g.move(-1)
  else if (action === 'R') g.move(1)
  else if (action === 'CW') g.rotate(1)
  else if (action === 'CCW') g.rotate(-1)
  else if (action === 'HD') while (g.softDrop()) { /* 接地するまで落とす */ }
  else throw new Error(`知らない操作: ${action}`)
}

function setup(g: BlobGame, rows: string[]): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) g.field.set(x, y, Number(rows[y]?.[x] ?? 0))
  }
}

describe('blob engine は Python 版と一致する', () => {
  it('盤の大きさ', () => {
    expect([W, H, VISIBLE_H]).toEqual([cases.size.W, cases.size.H, cases.size.VISIBLE_H])
  })

  it('乱数', () => {
    const r = new Rng(cases.rng.seed)
    for (const want of cases.rng.values) expect(r.next()).toBeCloseTo(want, 12)
  })

  it('組ぷよの出る順番', () => {
    const g = new BlobGame(cases.queues.seed)
    for (let i = 0; i < cases.queues.pairs.length; i++) {
      expect([g.current!.axis, g.current!.child]).toEqual(cases.queues.pairs[i])
      g.current = { ...g.current!, x: i % W, rot: 0 }
      apply(g, 'HD')
      g.lock()
      resolve(g)
      g.spawn()
    }
  })

  for (const c of cases.random_games) {
    it(`ランダム対局 seed=${c.seed}（${c.turns.length} 手）`, () => {
      const g = new BlobGame(c.seed)
      c.turns.forEach((turn, i) => {
        if (turn.garbage) g.receiveGarbage(turn.garbage)
        for (const a of turn.actions) apply(g, a)
        g.lock()
        const r = resolve(g)
        g.dropGarbage()
        g.spawn()
        const got = { ...r, rows: rowsOf(g), pending: g.pending }
        expect(got, `${i} 手目`).toEqual({
          chain: turn.chain, score: turn.score, attack: turn.attack, cancelled: turn.cancelled,
          sent: turn.sent, allClear: turn.all_clear, rows: turn.rows, pending: turn.pending,
        })
      })
      expect(g.score).toBe(c.final.score)
      expect(g.maxChain).toBe(c.final.max_chain)
      expect(g.over).toBe(c.final.over)
    })
  }

  it('4 連鎖以上の 1 手（得点と送るおじゃまの数）', () => {
    const c = cases.chain4
    const g = new BlobGame(5)
    setup(g, c.setup)
    g.current = { x: c.place[0], y: g.current!.y, rot: c.place[1] as 0 | 1 | 2 | 3, axis: c.axis, child: c.child }
    apply(g, 'HD')
    g.lock()
    const r = resolve(g)
    expect([r.chain, r.score, r.attack, r.sent]).toEqual([c.chain, c.score, c.attack, c.sent])
    expect(rowsOf(g)).toEqual(c.rows)
  })

  it('おじゃまの降り方（端数の列）', () => {
    const g = new BlobGame(cases.garbage.seed)
    g.receiveGarbage(cases.garbage.received)
    expect(g.dropGarbage()).toEqual(cases.garbage.first)
    expect(g.dropGarbage()).toEqual(cases.garbage.second)
    expect(rowsOf(g)).toEqual(cases.garbage.rows)
    expect(g.field.cells.filter((c) => c === GARBAGE).length).toBe(cases.garbage.received)
  })
})
