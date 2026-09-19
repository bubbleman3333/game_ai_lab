// 評価関数。どれも「手番側から見た石差のだいたいの予想」を返す（探索はこの値の大小だけを見る）。
//   NTupleEvaluator: 学習した n-tuple ネットワーク（backend/rl/othello/ntuple.py と同じ計算）
//   PositionalEvaluator: マスの重み表（学習なし）

import { EMPTY, legalMoves, opponent, type Cells, type Color } from './board'

export interface Evaluator {
  evaluate(cells: Cells, toMove: Color): number
}

/** GET /api/othello/spec/ の中身 */
export interface NTupleSpec {
  version: number
  stages: number
  table_size: number
  patterns: { name: string; size: number; offset: number }[]
  instances: { pattern: number; cells: number[] }[]
}

export class NTupleEvaluator implements Evaluator {
  private cells: Int32Array[] // インスタンスごとのマス
  private base: Int32Array // インスタンスごとの重みの開始位置（段階の中）
  private stages: number
  private tableSize: number
  private weights: Float32Array

  constructor(spec: NTupleSpec, weights: Float32Array) {
    if (weights.length !== spec.stages * spec.table_size) {
      throw new Error(`重みの数が合いません（${weights.length} ≠ ${spec.stages * spec.table_size}）`)
    }
    this.cells = spec.instances.map((i) => Int32Array.from(i.cells))
    this.base = Int32Array.from(spec.instances.map((i) => spec.patterns[i.pattern].offset))
    this.stages = spec.stages
    this.tableSize = spec.table_size
    this.weights = weights
  }

  /** 学習時と同じ「手番側から見た最終石差 / 64」の予想を返す */
  raw(cells: Cells, toMove: Color): number {
    let discs = 0
    for (let i = 0; i < 64; i++) if (cells[i] !== EMPTY) discs++
    const stage = Math.min(this.stages - 1, Math.max(0, Math.floor((discs - 4) / 10)))
    const off = stage * this.tableSize
    let sum = 0
    for (let k = 0; k < this.cells.length; k++) {
      const cs = this.cells[k]
      let idx = 0
      for (let j = 0; j < cs.length; j++) {
        const v = cells[cs[j]]
        idx = idx * 3 + (v === EMPTY ? 0 : v === toMove ? 1 : 2)
      }
      sum += this.weights[off + this.base[k] + idx]
    }
    return sum
  }

  evaluate(cells: Cells, toMove: Color): number {
    return this.raw(cells, toMove) * 64
  }
}

const SQUARE_WEIGHTS = [
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, -1, -1, -1, -1, -2, 10,
  5, -2, -1, -1, -1, -1, -2, 5,
  5, -2, -1, -1, -1, -1, -2, 5,
  10, -2, -1, -1, -1, -1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
]

/** backend/rl/othello/players.py の positional_eval と同じ考え方（学習なしの比較用） */
export class PositionalEvaluator implements Evaluator {
  evaluate(cells: Cells, toMove: Color): number {
    const opp = opponent(toMove)
    let s = 0
    for (let i = 0; i < 64; i++) {
      if (cells[i] === toMove) s += SQUARE_WEIGHTS[i]
      else if (cells[i] === opp) s -= SQUARE_WEIGHTS[i]
    }
    const mob = legalMoves(cells, toMove).length - legalMoves(cells, opp).length
    return (s + 5 * mob) / 4
  }
}

