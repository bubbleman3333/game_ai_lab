// 種（seed）つきの乱数。同じ種なら毎回同じ街ができる（街の形を覚えられるように）。

export type Rng = () => number

/** mulberry32。0 以上 1 未満を返す */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const range = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng()
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
export const chance = (rng: Rng, p: number) => rng() < p
