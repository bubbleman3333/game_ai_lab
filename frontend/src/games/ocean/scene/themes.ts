// 区間ごとの見た目（色）。ルールの数字は sim/zones.ts にある。
//
// 区間が変わるとき、色はここの値へじわっと寄せる（OceanScene.ts の update）。
// 色を足したり変えたりするときはこのファイルだけを直せばよい。

import type { ZoneId } from '../sim/zones'

export interface Theme {
  /** HUD の強調色（CSS） */
  accent: string
  skyTop: number
  skyBottom: number
  /** 海面を上から見たときの色（深い側・浅い側） */
  waterDeep: number
  waterShallow: number
  /** 海面の霧（空気側） */
  fogAir: number
  fogAirFar: number
  /** 水中の霧の色と見える距離 */
  fogWater: number
  fogWaterFar: number
  /** 海底の色（深さは sim/zones.ts の floorY。ルールにも効くのでそちらに置く） */
  floor: number
  sunColor: number
  sunStrength: number
  ambient: number
  ambientStrength: number
  /** 太陽の向き（正規化していなくてよい） */
  sunDir: [number, number, number]
  /** クラゲの光り方（夜は強い） */
  jellyGlow: number
  /** 星を出すか */
  stars: boolean
}

export const THEMES: Record<ZoneId, Theme> = {
  shallow: {
    accent: '#5fd8ff',
    skyTop: 0x2f7fd8, skyBottom: 0xbfe6f5,
    waterDeep: 0x0b5f8a, waterShallow: 0x37b7c9,
    fogAir: 0xbfe0ee, fogAirFar: 420,
    fogWater: 0x1c7d9a, fogWaterFar: 60,
    floor: 0xc9b98a,
    sunColor: 0xfff2d8, sunStrength: 2.6,
    ambient: 0xcfe8ff, ambientStrength: 1.1,
    sunDir: [0.5, 1, 0.35],
    jellyGlow: 0.5,
    stars: false,
  },
  offshore: {
    accent: '#3f9bff',
    skyTop: 0x1b4f9c, skyBottom: 0x9fc4e6,
    waterDeep: 0x03294d, waterShallow: 0x1b6f9e,
    fogAir: 0xa8c6de, fogAirFar: 380,
    fogWater: 0x0a3f66, fogWaterFar: 42,
    floor: 0x24384a,
    sunColor: 0xffe9c8, sunStrength: 2.2,
    ambient: 0xa9c8ea, ambientStrength: 0.9,
    sunDir: [0.3, 0.8, 0.5],
    jellyGlow: 0.9,
    stars: false,
  },
  night: {
    accent: '#b58cff',
    skyTop: 0x070d26, skyBottom: 0x26306a,
    waterDeep: 0x061635, waterShallow: 0x1a3f7a,
    fogAir: 0x1c2650, fogAirFar: 300,
    fogWater: 0x071531, fogWaterFar: 32,
    floor: 0x0a1020,
    sunColor: 0xb8c8ff, sunStrength: 1.1,
    ambient: 0x5c6fb8, ambientStrength: 0.9,
    sunDir: [-0.4, 0.9, 0.2],
    jellyGlow: 2.6,
    stars: true,
  },
}

export function themeFor(id: ZoneId): Theme {
  return THEMES[id]
}
