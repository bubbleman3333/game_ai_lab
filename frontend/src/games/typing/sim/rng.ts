// 種を決められる乱数（mulberry32）。同じ種なら同じ順で影が出るので、テストで再現できる。

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  /** 0 以上 1 未満 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** lo 以上 hi 未満 */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  /** lo 以上 hi 以下の整数 */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }
}
