// 車の「見た目」の設計図。箱と円柱をいくつ、どの大きさで、どこに置くか、という表。
//
// 走りの性能（速さ・グリップなど）はここには無い。性能は shared/cars/<名前>.json にあり、
// Python 版と共有している。見た目と性能を分けてあるので、ここを変えても走りは 1mm も変わらない
// （= AI の学習をやり直す必要がない）。
//
// 新しい車を足すときは
//   1. shared/cars/<名前>.json に性能を書く（Python と共有）
//   2. この表に同じ名前で見た目を足す
// の 2 つ。2 を忘れても、既定の見た目で走れる。
//
// 座標は車のローカル: x = 右、y = 上、z = 前。単位はメートル。

export interface Part {
  /** 形。box = 直方体、wedge = 前が低くなった台形（ボンネット）、cylinder = 円柱 */
  shape: 'box' | 'wedge' | 'cylinder'
  /** 大きさ（幅・高さ・奥行き）。cylinder は [直径, 長さ, 直径] */
  size: [number, number, number]
  /** 車の中心からの位置 */
  at: [number, number, number]
  color: number
  /** 金属っぽさ・つるつる具合（0〜1）。省略すると塗装っぽい見た目になる */
  metal?: number
  rough?: number
  /** 光らせる（ライト・ネオン） */
  glow?: number
  /** x 軸まわりに傾ける（ラジアン）。円柱を横に倒すときなどに使う */
  rotX?: number
  rotZ?: number
  /** 左右対称に 2 つ置く（at の x を ± にする） */
  mirror?: boolean
}

export interface CarDesign {
  /** タイヤの半径と幅、前後・左右の取り付け位置 */
  wheel: { radius: number; width: number; front: number; back: number; side: number; color: number }
  /** 車体のパーツ */
  parts: Part[]
  /** 影を落とす楕円の大きさ（幅・奥行き） */
  shadow: [number, number]
}

const DEFAULT: CarDesign = {
  wheel: { radius: 0.42, width: 0.3, front: 1.25, back: -1.3, side: 0.92, color: 0x1b1b20 },
  shadow: [2.3, 4.6],
  parts: [
    { shape: 'box', size: [1.85, 0.5, 4.1], at: [0, 0.52, 0], color: 0xdd3b42, rough: 0.35 },
    { shape: 'wedge', size: [1.7, 0.42, 1.6], at: [0, 0.86, 1.2], color: 0xdd3b42, rough: 0.35 },
    { shape: 'box', size: [1.5, 0.52, 1.5], at: [0, 1.03, -0.25], color: 0x20242e, rough: 0.15, metal: 0.4 },
    { shape: 'box', size: [1.95, 0.16, 0.5], at: [0, 1.28, -1.75], color: 0x20242e },
    { shape: 'box', size: [0.14, 0.42, 0.14], at: [0.8, 1.05, -1.75], color: 0x20242e, mirror: true },
    { shape: 'box', size: [0.34, 0.16, 0.12], at: [0.62, 0.72, 2.03], color: 0xfff0c0, glow: 2.2, mirror: true },
    { shape: 'box', size: [0.3, 0.14, 0.1], at: [0.6, 0.66, -2.06], color: 0xff3b30, glow: 1.6, mirror: true },
    { shape: 'cylinder', size: [0.22, 0.5, 0.22], at: [0.45, 0.35, -2.1], color: 0x8a8f99, metal: 0.9, rough: 0.3, rotX: Math.PI / 2, mirror: true },
  ],
}

/** 車の ID（shared/cars/*.json の名前）ごとの見た目 */
export const CAR_DESIGNS: Record<string, CarDesign> = {
  // ルナ: 素直な形のバランス型
  balanced: DEFAULT,

  // コメット: 低く長い、直線番長。大きなリアウイングつき
  speed: {
    wheel: { radius: 0.4, width: 0.32, front: 1.45, back: -1.5, side: 0.95, color: 0x17171c },
    shadow: [2.4, 5.2],
    parts: [
      { shape: 'box', size: [1.8, 0.4, 4.7], at: [0, 0.44, 0], color: 0x2f6fe0, rough: 0.2, metal: 0.5 },
      { shape: 'wedge', size: [1.62, 0.34, 2.1], at: [0, 0.72, 1.4], color: 0x2f6fe0, rough: 0.2, metal: 0.5 },
      { shape: 'box', size: [1.3, 0.42, 1.3], at: [0, 0.85, -0.4], color: 0x111726, rough: 0.1, metal: 0.6 },
      { shape: 'box', size: [2.2, 0.12, 0.62], at: [0, 1.32, -2.05], color: 0xf0f2f6 },
      { shape: 'box', size: [0.14, 0.58, 0.5], at: [0.92, 1.0, -2.0], color: 0xf0f2f6, mirror: true },
      { shape: 'box', size: [0.5, 0.12, 0.12], at: [0.55, 0.6, 2.35], color: 0xd8f0ff, glow: 2.6, mirror: true },
      { shape: 'box', size: [0.34, 0.12, 0.1], at: [0.58, 0.56, -2.36], color: 0xff3b30, glow: 1.6, mirror: true },
      { shape: 'cylinder', size: [0.2, 0.46, 0.2], at: [0.4, 0.3, -2.4], color: 0x9aa0aa, metal: 0.95, rough: 0.25, rotX: Math.PI / 2, mirror: true },
    ],
  },

  // バジャー: 背が高く幅広の悪路向き。ルーフラックつき
  grip: {
    wheel: { radius: 0.52, width: 0.4, front: 1.2, back: -1.25, side: 0.98, color: 0x23231f },
    shadow: [2.6, 4.6],
    parts: [
      { shape: 'box', size: [2.0, 0.66, 3.9], at: [0, 0.68, 0], color: 0xf2b035, rough: 0.55 },
      { shape: 'wedge', size: [1.86, 0.4, 1.2], at: [0, 1.05, 1.15], color: 0xf2b035, rough: 0.55 },
      { shape: 'box', size: [1.68, 0.72, 1.7], at: [0, 1.32, -0.35], color: 0x2c2f38, rough: 0.3 },
      { shape: 'box', size: [1.6, 0.1, 1.4], at: [0, 1.72, -0.35], color: 0x4a4f5a, metal: 0.6 },
      { shape: 'box', size: [0.2, 0.2, 4.0], at: [1.02, 0.48, 0], color: 0x2c2f38, mirror: true },
      { shape: 'box', size: [0.4, 0.2, 0.14], at: [0.66, 0.95, 1.95], color: 0xfff2cc, glow: 2.4, mirror: true },
      { shape: 'box', size: [0.34, 0.16, 0.12], at: [0.66, 0.85, -1.96], color: 0xff3b30, glow: 1.6, mirror: true },
      { shape: 'cylinder', size: [0.26, 0.5, 0.26], at: [0.5, 0.42, -2.0], color: 0x7d838d, metal: 0.9, rough: 0.35, rotX: Math.PI / 2, mirror: true },
    ],
  },
}

export const designFor = (carId: string): CarDesign => CAR_DESIGNS[carId] ?? DEFAULT
