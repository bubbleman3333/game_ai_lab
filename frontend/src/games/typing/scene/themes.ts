// 章ごとの色と景色。sim/chapters.ts の章の id と同じ id で書く。
// 数字は 16 進の色（0xRRGGBB）。暗い森なので、霧と空はかなり暗くしてある。

export interface Theme {
  skyTop: number
  skyBottom: number
  fog: number
  /** 霧の濃さ（大きいほど近くまでしか見えない。0.03〜0.08 くらい） */
  fogDensity: number
  ground: number
  path: number
  foliage: number
  trunk: number
  /** ランタンの光の色 */
  lantern: number
  moon: number
  /** 月の大きさ（0 で出さない） */
  moonSize: number
  ambient: number
  /** 景色の小物 */
  props: { water?: number; torii?: boolean; stoneLanterns?: boolean; mushrooms?: boolean; fewTrees?: boolean }
  /** HUD の差し色（CSS の色） */
  accent: string
  /** 夜明けの空（終章でボスを削るほどこの色に寄る） */
  dawnTop?: number
  dawnBottom?: number
}

export const THEMES: Record<string, Theme> = {
  entrance: {
    skyTop: 0x050814, skyBottom: 0x14203a, fog: 0x0b1222, fogDensity: 0.045,
    ground: 0x16221a, path: 0x2a2a22, foliage: 0x0f2a1c, trunk: 0x241a14,
    lantern: 0xffb45a, moon: 0xf4f1d8, moonSize: 3, ambient: 0x2a3550,
    props: { mushrooms: true }, accent: '#ffc46b',
  },
  marsh: {
    skyTop: 0x060b10, skyBottom: 0x1d2a2e, fog: 0x2a3a3c, fogDensity: 0.075,
    ground: 0x1a2420, path: 0x23302a, foliage: 0x13261f, trunk: 0x1f1c18,
    lantern: 0xffcf7a, moon: 0xd8e4dc, moonSize: 2.2, ambient: 0x37504c,
    props: { water: 0x0d1c1e }, accent: '#9fe3c8',
  },
  shrine: {
    skyTop: 0x0a0612, skyBottom: 0x2a1830, fog: 0x1a1020, fogDensity: 0.045,
    ground: 0x1b1d16, path: 0x3a3832, foliage: 0x112218, trunk: 0x2a1c14,
    lantern: 0xffa850, moon: 0xffe8c8, moonSize: 3, ambient: 0x3a2a48,
    props: { torii: true, stoneLanterns: true }, accent: '#ff8a6b',
  },
  spring: {
    skyTop: 0x040a1e, skyBottom: 0x1a3060, fog: 0x0c1830, fogDensity: 0.035,
    ground: 0x141e24, path: 0x26303a, foliage: 0x0e2230, trunk: 0x1e1c22,
    lantern: 0xffd890, moon: 0xffffff, moonSize: 6, ambient: 0x3a4a78,
    props: { water: 0x0a1a38, mushrooms: true }, accent: '#a8c8ff',
  },
  dawn: {
    skyTop: 0x05040c, skyBottom: 0x1a1430, fog: 0x120e20, fogDensity: 0.04,
    ground: 0x1a1a1a, path: 0x2a2620, foliage: 0x121a16, trunk: 0x221a16,
    lantern: 0xffc070, moon: 0xe8e0ff, moonSize: 4, ambient: 0x302a48,
    props: { fewTrees: true }, accent: '#ffd27a',
    dawnTop: 0x3a5a9a, dawnBottom: 0xffb070,
  },
  endless: {
    skyTop: 0x020206, skyBottom: 0x0e0a1c, fog: 0x08060f, fogDensity: 0.05,
    ground: 0x111411, path: 0x22201c, foliage: 0x0c1a12, trunk: 0x1a1410,
    lantern: 0xff9a40, moon: 0xff6a5a, moonSize: 3.5, ambient: 0x261e38,
    props: { mushrooms: true, stoneLanterns: true }, accent: '#ff7a6b',
  },
}

export function themeFor(id: string): Theme {
  return THEMES[id] ?? THEMES.entrance
}
