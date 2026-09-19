// Web Worker（worker.ts）を Promise で使うためのラッパー。

import type { Cells, Color } from '../engine/board'
import type { NTupleSpec } from '../engine/evaluators'
import type { SearchOptions, SearchResult } from '../engine/search'

export type WorkerRequest =
  | { id: number; type: 'evaluator'; kind: 'ntuple'; spec: NTupleSpec; weights: Float32Array }
  | { id: number; type: 'evaluator'; kind: 'positional' }
  | { id: number; type: 'search'; cells: Cells; toMove: Color; options: SearchOptions }

export type WorkerResponse =
  | { id: number; type: 'ok' }
  | { id: number; type: 'result'; result: SearchResult }
  | { id: number; type: 'error'; message: string }

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
// union の各型から id を外す（Omit は union にそのまま使うと共通部分しか残らない）
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export class OthelloAi {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id)
      if (!p) return
      this.pending.delete(e.data.id)
      if (e.data.type === 'error') p.reject(new Error(e.data.message))
      else p.resolve(e.data)
    }
  }

  private send(msg: WithoutId<WorkerRequest>): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...msg, id })
    })
  }

  async useNTuple(spec: NTupleSpec, weights: Float32Array): Promise<void> {
    await this.send({ type: 'evaluator', kind: 'ntuple', spec, weights })
  }

  async usePositional(): Promise<void> {
    await this.send({ type: 'evaluator', kind: 'positional' })
  }

  async search(cells: Cells, toMove: Color, options: SearchOptions): Promise<SearchResult> {
    const r = await this.send({ type: 'search', cells: cells.slice(), toMove, options })
    if (r.type !== 'result') throw new Error('unexpected response')
    return r.result
  }

  terminate(): void {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('AI を停止しました'))
    this.pending.clear()
  }
}
