// 先読み（探索）。アルファベータ法（ネガマックス形式）で数手先まで読み、終盤は最後まで読み切る。
//
//   中盤: 深さ 1, 2, 3 … と順に深くしていき（反復深化）、時間切れになったら最後に読み切れた深さの結果を使う。
//         末端の局面は評価関数（学習した n-tuple など）で点数をつける。
//   終盤: 空きマスが exactEmpties 以下なら終局まで全部読み、正確な石差で打つ（完全読み）。
//
// React・DOM には依存しない（Web Worker の中で動かす。worker.ts 参照）。

import {
  EMPTY, finalScore, hasMove, legalMoves, opponent, play, undo, type Cells, type Color,
} from './board'
import type { Evaluator } from './evaluators'

export interface SearchOptions {
  /** 中盤に読む最大の深さ（手数） */
  maxDepth: number
  /** 考える時間の上限（ms） */
  timeMs: number
  /** 空きマスがこれ以下なら完全読みを試す（0 なら使わない） */
  exactEmpties: number
  /** 手の点数に加えるランダムな揺らぎ（石差の単位。弱くするため） */
  noise?: number
}

export interface MoveScore {
  move: number
  score: number
}

export interface SearchResult {
  move: number
  /** 手番側から見た予想石差（exact なら正確な石差） */
  score: number
  depth: number
  exact: boolean
  nodes: number
  timeMs: number
  /** 最後に読み切った深さでの、すべての手の点数（評価値表示に使う） */
  scores: MoveScore[]
}

class TimeUp extends Error {}

// 読む順番の目安（角を先に、角の隣を後に）
const STATIC_ORDER = [
  9, 1, 7, 6, 6, 7, 1, 9,
  1, 0, 3, 3, 3, 3, 0, 1,
  7, 3, 5, 4, 4, 5, 3, 7,
  6, 3, 4, 2, 2, 4, 3, 6,
  6, 3, 4, 2, 2, 4, 3, 6,
  7, 3, 5, 4, 4, 5, 3, 7,
  1, 0, 3, 3, 3, 3, 0, 1,
  9, 1, 7, 6, 6, 7, 1, 9,
]
const byStatic = (a: number, b: number) => STATIC_ORDER[b] - STATIC_ORDER[a]

export class Searcher {
  private evaluator: Evaluator
  private nodes = 0
  private deadline = 0

  constructor(evaluator: Evaluator) {
    this.evaluator = evaluator
  }

  search(input: Cells, toMove: Color, opts: SearchOptions): SearchResult {
    const cells = input.slice()
    const started = performance.now()
    this.nodes = 0
    const moves = legalMoves(cells, toMove).sort(byStatic)
    if (!moves.length) throw new Error('打てる手がありません')

    let empties = 0
    for (let i = 0; i < 64; i++) if (cells[i] === EMPTY) empties++

    // 終盤: 完全読み（時間の 6 割まで。間に合わなければ中盤の探索に切り替える）
    if (opts.exactEmpties > 0 && empties <= opts.exactEmpties) {
      this.deadline = started + opts.timeMs * 0.6
      try {
        const scores = this.rootScores(cells, toMove, moves, (c, color, a, b) => -this.exact(c, color, a, b), -64, 64)
        return this.finish(scores, empties, true, started, opts)
      } catch (e) {
        if (!(e instanceof TimeUp)) throw e
      }
    }

    // 中盤: 反復深化
    this.deadline = started + opts.timeMs
    let best: MoveScore[] | null = null
    let depth = 0
    for (let d = 1; d <= opts.maxDepth; d++) {
      try {
        const order = best ? best.map((s) => s.move) : moves
        const scores = this.rootScores(cells, toMove, order, (c, color, a, b) => -this.negamax(c, color, d - 1, a, b), -Infinity, Infinity)
        best = scores
        depth = d
      } catch (e) {
        if (!(e instanceof TimeUp)) throw e
        break
      }
      if (d >= empties) break // それ以上深く読めない
    }
    if (!best) best = moves.map((m) => ({ move: m, score: 0 }))
    return this.finish(best, depth, false, started, opts)
  }

  /** ルートの全部の手の点数（最善手以外は「最善より悪い」ことが分かった時点で打ち切る） */
  private rootScores(
    cells: Cells, toMove: Color, moves: number[],
    child: (c: Cells, color: Color, alpha: number, beta: number) => number, lo: number, hi: number,
  ): MoveScore[] {
    const opp = opponent(toMove)
    const scores: MoveScore[] = []
    let alpha = lo
    for (const m of moves) {
      const flipped = play(cells, toMove, m)
      // 評価値表示のため、各手の点数を正しく出せるよう窓は (alpha - 32, hi) にする
      const s = child(cells, opp, -hi, -(alpha === -Infinity ? alpha : alpha - 32))
      undo(cells, toMove, m, flipped)
      scores.push({ move: m, score: s })
      if (s > alpha) alpha = s
    }
    return scores.sort((a, b) => b.score - a.score)
  }

  private finish(scores: MoveScore[], depth: number, exact: boolean, started: number, opts: SearchOptions): SearchResult {
    let chosen = scores[0]
    if (opts.noise) {
      const noisy = scores.map((s) => ({ ...s, n: s.score + (Math.random() * 2 - 1) * opts.noise! }))
      noisy.sort((a, b) => b.n - a.n)
      chosen = scores.find((s) => s.move === noisy[0].move)!
    }
    return {
      move: chosen.move, score: chosen.score, depth, exact, nodes: this.nodes,
      timeMs: Math.round(performance.now() - started), scores,
    }
  }

  private tick(): void {
    if ((++this.nodes & 1023) === 0 && performance.now() > this.deadline) throw new TimeUp()
  }

  /** 中盤の探索。手番側から見た点数 */
  private negamax(cells: Cells, color: Color, depth: number, alpha: number, beta: number): number {
    this.tick()
    const opp = opponent(color)
    if (depth <= 0) return this.evaluator.evaluate(cells, color)
    const moves = legalMoves(cells, color)
    if (!moves.length) {
      if (!hasMove(cells, opp)) return finalScore(cells, color)
      return -this.negamax(cells, opp, depth, -beta, -alpha) // パス（深さは減らさない）
    }
    this.order(cells, color, moves, depth)
    let best = -Infinity
    for (const m of moves) {
      const flipped = play(cells, color, m)
      const v = -this.negamax(cells, opp, depth - 1, -beta, -alpha)
      undo(cells, color, m, flipped)
      if (v > best) {
        best = v
        if (v > alpha) {
          alpha = v
          if (alpha >= beta) break
        }
      }
    }
    return best
  }

  /** 完全読み。手番側から見た最終石差 */
  private exact(cells: Cells, color: Color, alpha: number, beta: number): number {
    this.tick()
    const opp = opponent(color)
    const moves = legalMoves(cells, color)
    if (!moves.length) {
      if (!hasMove(cells, opp)) return finalScore(cells, color)
      return -this.exact(cells, opp, -beta, -alpha)
    }
    if (moves.length > 1) {
      // 相手の打てる手が少なくなる手から読む（早く枝刈りできる）
      const mob = new Map<number, number>()
      for (const m of moves) {
        const f = play(cells, color, m)
        mob.set(m, legalMoves(cells, opp).length * 16 - STATIC_ORDER[m])
        undo(cells, color, m, f)
      }
      moves.sort((a, b) => mob.get(a)! - mob.get(b)!)
    }
    let best = -Infinity
    for (const m of moves) {
      const flipped = play(cells, color, m)
      const v = -this.exact(cells, opp, -beta, -alpha)
      undo(cells, color, m, flipped)
      if (v > best) {
        best = v
        if (v > alpha) {
          alpha = v
          if (alpha >= beta) break
        }
      }
    }
    return best
  }

  /** 読む順番を並べ替える。深い局面では評価関数で良さそうな手から読む（枝刈りが効く） */
  private order(cells: Cells, color: Color, moves: number[], depth: number): void {
    if (depth < 3 || moves.length < 2) {
      moves.sort(byStatic)
      return
    }
    const opp = opponent(color)
    const v = new Map<number, number>()
    for (const m of moves) {
      const f = play(cells, color, m)
      v.set(m, this.evaluator.evaluate(cells, opp)) // 相手から見た点数（小さいほど自分に良い）
      undo(cells, color, m, f)
    }
    moves.sort((a, b) => v.get(a)! - v.get(b)!)
  }
}

/** 画面で選べる強さ */
export const LEVELS: Record<string, { label: string; options: SearchOptions }> = {
  beginner: { label: '入門（1 手読み・ゆらぎあり）', options: { maxDepth: 1, timeMs: 300, exactEmpties: 0, noise: 12 } },
  easy: { label: '初級（2 手読み）', options: { maxDepth: 2, timeMs: 500, exactEmpties: 6 } },
  normal: { label: '中級（4 手読み・終盤 10 マス読み切り）', options: { maxDepth: 4, timeMs: 1500, exactEmpties: 10 } },
  hard: { label: '上級（6 手読み・終盤 14 マス読み切り）', options: { maxDepth: 6, timeMs: 3000, exactEmpties: 14 } },
  max: { label: '最強（2 秒で読めるだけ・終盤 18 マス読み切り）', options: { maxDepth: 30, timeMs: 2000, exactEmpties: 18 } },
}
export type LevelId = keyof typeof LEVELS
