// 海の「区間」。泳いだ距離で切り替わり、危なさと見た目が変わる。
//
// ここにはルールに効く数字だけを置く（色や景色は scene/themes.ts。三次元の描画には依存しない）。
// 区間を足したいときは ZONES に 1 つ足し、scene/themes.ts に同じ id の色を足す。

export type ZoneId = 'shallow' | 'offshore' | 'night'

export interface Zone {
  id: ZoneId
  name: string
  /** この距離（m）から始まる */
  from: number
  /** クラゲの群れの間隔（m）。小さいほど多い */
  jellyGap: [number, number]
  /** 1 つの群れのクラゲの数 */
  jellyCount: [number, number]
  /** サメが来る間隔（秒） */
  sharkInterval: [number, number]
  /** サメが 1 回の来襲で突っ込んでくる回数 */
  sharkPasses: [number, number]
  /** 真珠の間隔（m） */
  pearlGap: [number, number]
  /** 海底の深さ（m）。浅瀬では潜れる深さがここで頭打ちになる（見た目の海底もこの深さ） */
  floorY: number
  /** クラゲがいる深さの範囲 */
  jellyDepth: [number, number]
}

export const ZONES: readonly Zone[] = [
  {
    id: 'shallow', name: '浅瀬', from: 0,
    jellyGap: [22, 40], jellyCount: [1, 3],
    sharkInterval: [22, 34], sharkPasses: [1, 2],
    pearlGap: [18, 32],
    floorY: -16, jellyDepth: [-8, -0.4],
  },
  {
    id: 'offshore', name: '沖合', from: 400,
    jellyGap: [14, 26], jellyCount: [2, 4],
    sharkInterval: [16, 26], sharkPasses: [2, 3],
    pearlGap: [22, 40],
    floorY: -48, jellyDepth: [-14, -0.4],
  },
  {
    id: 'night', name: '夜の海', from: 1000,
    jellyGap: [10, 20], jellyCount: [3, 6],
    sharkInterval: [12, 20], sharkPasses: [2, 4],
    pearlGap: [26, 44],
    floorY: -48, jellyDepth: [-18, -0.4],
  },
]

/** 距離（m）に対応する区間 */
export function zoneAt(distance: number): Zone {
  let z = ZONES[0]
  for (const zone of ZONES) if (distance >= zone.from) z = zone
  return z
}

/** 区間の番号（0 始まり）。HUD で「次の区間まで」を出すのに使う */
export function zoneIndex(zone: Zone): number {
  return ZONES.indexOf(zone)
}
