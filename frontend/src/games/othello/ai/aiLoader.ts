// AI（Web Worker）に評価関数を読み込ませる。重みは AI ごとに一度だけダウンロードして覚えておく。

import { fetchSpec, fetchWeights } from '../api/othello'
import type { NTupleSpec } from '../engine/evaluators'
import { OthelloAi } from './aiClient'

export const POSITIONAL_ID = 'positional'

export class AiLoader {
  readonly ai = new OthelloAi()
  private spec: Promise<NTupleSpec> | null = null
  private weights = new Map<string, Promise<Float32Array>>()
  private latest = 0 // 最後に頼まれた読み込みの番号

  /** agentId の評価関数に切り替える */
  async use(agentId: string): Promise<void> {
    const me = ++this.latest
    if (agentId === POSITIONAL_ID) {
      await this.ai.usePositional()
      return
    }
    this.spec ??= fetchSpec()
    if (!this.weights.has(agentId)) {
      const p = fetchWeights(agentId)
      this.weights.set(agentId, p)
      p.catch(() => this.weights.delete(agentId)) // 失敗したら次はもう一度ダウンロードする
    }
    const [spec, w] = await Promise.all([this.spec, this.weights.get(agentId)!])
    if (me !== this.latest) return // 待っている間に別の AI が選ばれた
    // Worker に渡すとコピーされるので、元の配列はそのまま使い回せる
    await this.ai.useNTuple(spec, w)
  }

  terminate(): void {
    this.ai.terminate()
  }
}
