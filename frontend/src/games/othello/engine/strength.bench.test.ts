// 対局画面と同じ「先読みあり」の AI どうしを対戦させて強さを比べる（通常のテストでは動かさない）。
// 使い方（backend を起動した状態で）:
//   PowerShell: $env:OTHELLO_BENCH="v1:best"; npx vitest run strength.bench
// 同じ探索（深さ・時間）で、評価関数だけ「学習した n-tuple」と「マスの重み表」を入れ替えて比べる。

import { describe, expect, it } from 'vitest'
import { BLACK, finalScore, hasMove, initialCells, legalMoves, opponent, play, type Color } from './board'
import { NTupleEvaluator, PositionalEvaluator, type Evaluator, type NTupleSpec } from './evaluators'
import { Searcher, type SearchOptions } from './search'

const AGENT = process.env.OTHELLO_BENCH
const API = process.env.OTHELLO_API ?? 'http://localhost:8000'

function playGame(black: Searcher, white: Searcher, opts: SearchOptions, opening: number[]): number {
  const cells = initialCells()
  let color: Color = BLACK
  for (const m of opening) {
    play(cells, color, m)
    color = opponent(color)
  }
  for (;;) {
    if (!hasMove(cells, color)) {
      if (!hasMove(cells, opponent(color))) break
      color = opponent(color)
    }
    const s = color === BLACK ? black : white
    play(cells, color, s.search(cells, color, opts).move)
    color = opponent(color)
  }
  return finalScore(cells, BLACK)
}

function randomOpenings(n: number, plies: number, seed: number): number[][] {
  let x = seed
  const rand = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x80000000)
  return Array.from({ length: n }, () => {
    const cells = initialCells()
    let color: Color = BLACK
    const moves: number[] = []
    for (let i = 0; i < plies; i++) {
      const ms = legalMoves(cells, color)
      const m = ms[Math.floor(rand() * ms.length)]
      play(cells, color, m)
      moves.push(m)
      color = opponent(color)
    }
    return moves
  })
}

describe.skipIf(!AGENT)('strength benchmark', () => {
  it('n-tuple vs positional (same search)', async () => {
    const spec = (await (await fetch(`${API}/api/othello/spec/`)).json()) as NTupleSpec
    const buf = await (await fetch(`${API}/api/othello/agents/${encodeURIComponent(AGENT!)}/weights/`)).arrayBuffer()
    const learned: Evaluator = new NTupleEvaluator(spec, new Float32Array(buf))
    const positional: Evaluator = new PositionalEvaluator()
    const opts: SearchOptions = { maxDepth: 4, timeMs: 10_000, exactEmpties: 10 }
    let wins = 0
    let draws = 0
    let diff = 0
    const openings = randomOpenings(15, 4, 7)
    for (const op of openings) {
      for (const learnedIsBlack of [true, false]) {
        const a = new Searcher(learned)
        const b = new Searcher(positional)
        const d = learnedIsBlack ? playGame(a, b, opts, op) : -playGame(b, a, opts, op)
        diff += d
        if (d > 0) wins++
        else if (d === 0) draws++
      }
    }
    const games = openings.length * 2
    console.log(`学習した評価関数 vs マスの重み表（両者 4 手読み + 終盤 10 マス読み切り）: ${wins} 勝 ${games - wins - draws} 敗 ${draws} 分、平均石差 ${(diff / games).toFixed(1)}`)
    expect(games).toBeGreaterThan(0)
  }, 600_000)
})
