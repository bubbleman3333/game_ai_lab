// 学習した方策（小さなニューラルネット）をブラウザで計算する。
// 重みは GET /api/airhockey/agents/<id>/policy/ の JSON（backend/rl/airhockey/policy.py の export_json）。

export interface PolicyJson {
  version: number
  activation: 'tanh'
  layers: { w: number[][]; b: number[] }[]
  meta?: { episode?: number }
}

export class Policy {
  private layers: { w: Float64Array[]; b: Float64Array }[]

  constructor(json: PolicyJson) {
    this.layers = json.layers.map((l) => ({ w: l.w.map((row) => Float64Array.from(row)), b: Float64Array.from(l.b) }))
  }

  /** 観測（12 個）→ 行動（2 個、-1〜1）。対局では平均の行動をそのまま使う */
  act(obs: number[]): [number, number] {
    let x = obs
    this.layers.forEach((l, i) => {
      const out = new Array<number>(l.b.length)
      for (let j = 0; j < l.b.length; j++) {
        let v = l.b[j]
        const row = l.w[j]
        for (let k = 0; k < row.length; k++) v += row[k] * x[k]
        out[j] = i < this.layers.length - 1 ? Math.tanh(v) : v
      }
      x = out
    })
    return [Math.min(Math.max(x[0], -1), 1), Math.min(Math.max(x[1], -1), 1)]
  }
}
