// Python 版（backend/games/othello, backend/rl/othello/ntuple.py）と同じ結果になるかを確かめる。
// データの作り直し: cd backend; python -m games.othello.fixtures

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BLACK, WHITE, finalScore, fromStrings, initialCells, legalMoves, play, sqToStr, strToSq, toStrings, undo,
  type Color,
} from './board'
import { NTupleEvaluator, type NTupleSpec } from './evaluators'
import { Searcher } from './search'

const data = JSON.parse(
  readFileSync(new URL('../../../../../shared/fixtures/othello/engine_cases.json', import.meta.url), 'utf-8'),
)

/** Python 側と同じ式のテスト用の重み */
function formulaWeights(spec: NTupleSpec): Float32Array {
  const w = new Float32Array(spec.stages * spec.table_size)
  for (let s = 0; s < spec.stages; s++)
    for (let i = 0; i < spec.table_size; i++) w[s * spec.table_size + i] = (((i * 7919 + s * 104729) % 2001) / 1000) - 1
  return w
}

describe('othello engine matches Python', () => {
  for (const g of data.games) {
    it(`random game seed=${g.seed}`, () => {
      const cells = initialCells()
      let color: Color = BLACK
      const opp = (c: Color): Color => (c === BLACK ? WHITE : BLACK)
      for (let i = 0; i < g.legal.length; i++) {
        if (!legalMoves(cells, color).length) color = opp(color) // パス
        expect(legalMoves(cells, color).map(sqToStr)).toEqual(g.legal[i])
        play(cells, color, strToSq(g.moves.slice(i * 2, i * 2 + 2)))
        color = opp(color)
      }
      if (!legalMoves(cells, color).length && legalMoves(cells, opp(color)).length) color = opp(color)
      expect(toStrings(cells)).toEqual(g.final_board)
      expect(finalScore(cells, color)).toBe(g.final_score_for_side_to_move)
      expect(color === BLACK).toBe(g.final_black_to_move)
    })
  }

  it('n-tuple evaluation', () => {
    const spec = data.spec as NTupleSpec
    const ev = new NTupleEvaluator(spec, formulaWeights(spec))
    for (const c of data.eval) {
      const v = ev.raw(fromStrings(c.board), c.black_to_move ? BLACK : WHITE)
      expect(v).toBeCloseTo(c.value, 3)
    }
  })
})

describe('search', () => {
  it('play / undo restores the board', () => {
    const cells = initialCells()
    const before = cells.slice()
    const f = play(cells, BLACK, strToSq('f5'))
    expect(f.length).toBe(1)
    undo(cells, BLACK, strToSq('f5'), f)
    expect(cells).toEqual(before)
  })

  it('exact solver matches brute force', () => {
    // 枝刈りなしで全部読んだ石差と、アルファベータの完全読みの結果が一致するか
    const brute = (cells: Int8Array, color: Color): number => {
      const o: Color = color === BLACK ? WHITE : BLACK
      const ms = legalMoves(cells, color)
      if (!ms.length) return legalMoves(cells, o).length ? -brute(cells, o) : finalScore(cells, color)
      let best = -Infinity
      for (const m of ms) {
        const f = play(cells, color, m)
        best = Math.max(best, -brute(cells, o))
        undo(cells, color, m, f)
      }
      return best
    }
    let checked = 0
    for (const g of data.games) {
      const cells = initialCells()
      let color: Color = BLACK
      const moves: string = g.moves
      const n = moves.length / 2
      for (let i = 0; i < n - 8; i++) {
        if (!legalMoves(cells, color).length) color = color === BLACK ? WHITE : BLACK
        play(cells, color, strToSq(moves.slice(i * 2, i * 2 + 2)))
        color = color === BLACK ? WHITE : BLACK
      }
      if (!legalMoves(cells, color).length) continue
      const r = new Searcher({ evaluate: () => 0 }).search(cells, color, { maxDepth: 20, timeMs: 10000, exactEmpties: 20 })
      expect(r.exact).toBe(true)
      expect(r.score).toBe(brute(cells.slice(), color))
      checked++
    }
    expect(checked).toBeGreaterThan(5)
  })
})
