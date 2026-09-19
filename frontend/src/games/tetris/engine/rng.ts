// mulberry32 と 7-bag。backend/tetris/rng.py と同じ値を出す。

import { PIECE_TYPES, type PieceType } from './pieces'

export class Mulberry32 {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** 0 以上 n 未満の整数 */
  nextInt(n: number): number {
    return Math.floor(this.nextFloat() * n)
  }
}

export class BagRandomizer {
  private rng: Mulberry32

  constructor(seed: number) {
    this.rng = new Mulberry32(seed)
  }

  nextBag(): PieceType[] {
    const bag = PIECE_TYPES.slice()
    for (let i = bag.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(i + 1)
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    return bag
  }
}
