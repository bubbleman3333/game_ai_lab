// AI の読みを画面と別のスレッド（Web Worker）で動かす。読んでいる間も画面が固まらない。
// メッセージの形は aiClient.ts の WorkerRequest / WorkerResponse。

import { NTupleEvaluator, PositionalEvaluator, type Evaluator } from '../engine/evaluators'
import { Searcher } from '../engine/search'
import type { WorkerRequest, WorkerResponse } from './aiClient'

let searcher = new Searcher(new PositionalEvaluator())

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  const reply = (r: WorkerResponse) => (self as unknown as Worker).postMessage(r)
  try {
    if (msg.type === 'evaluator') {
      const ev: Evaluator = msg.kind === 'ntuple' ? new NTupleEvaluator(msg.spec, msg.weights) : new PositionalEvaluator()
      searcher = new Searcher(ev)
      reply({ id: msg.id, type: 'ok' })
    } else if (msg.type === 'search') {
      reply({ id: msg.id, type: 'result', result: searcher.search(msg.cells, msg.toMove, msg.options) })
    }
  } catch (err) {
    reply({ id: msg.id, type: 'error', message: (err as Error).message })
  }
}
