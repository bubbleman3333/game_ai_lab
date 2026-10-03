// 章ごとの色と景色。sim/chapters.ts の章の id と同じ id で書く。
// 数字は 16 進の色（0xRRGGBB）。暗い森なので、霧と空はかなり暗くしてある。

import { NORMAL_SHAPES, type ShapeName } from './shade'

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
  /** 地面を這う霧の濃さ（0〜1） */
  mist: number
  /** この章に出る影の形（scene/shade.ts の SHAPES）。同じ形を何度も書くと出やすくなる */
  shades: ShapeName[]
  /** 影の輪郭のもやの色 */
  shadeAura: number
  /** ボスの形 */
  bossShape: ShapeName
  /** タイトル・メニュー・物語の背景で、遠くに漂わせる影の数（村の場面では 0） */
  decor?: number
  /** 手元のランタンを出さない（物語でランタンを受け取る前の村・灯が役目を終えた朝） */
  noLantern?: boolean
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
    lantern: 0xffb45a, moon: 0xf4f1d8, moonSize: 3, ambient: 0x2a3550, mist: 0.35,
    shades: ['round', 'round', 'cat', 'kodama', 'umbrella', 'oni', 'lantern'], shadeAura: 0x5230c0, bossShape: 'roots',
    props: { mushrooms: true }, accent: '#ffc46b',
  },
  marsh: {
    skyTop: 0x060b10, skyBottom: 0x1d2a2e, fog: 0x2a3a3c, fogDensity: 0.075,
    ground: 0x1a2420, path: 0x23302a, foliage: 0x13261f, trunk: 0x1f1c18,
    lantern: 0xffcf7a, moon: 0xd8e4dc, moonSize: 2.2, ambient: 0x37504c, mist: 0.75,
    shades: ['jelly', 'oneEye', 'tall', 'serpent', 'kodama', 'round'], shadeAura: 0x2a8a7a, bossShape: 'mist',
    props: { water: 0x0d1c1e }, accent: '#9fe3c8',
  },
  shrine: {
    skyTop: 0x0a0612, skyBottom: 0x2a1830, fog: 0x1a1020, fogDensity: 0.045,
    ground: 0x1b1d16, path: 0x3a3832, foliage: 0x112218, trunk: 0x2a1c14,
    lantern: 0xffa850, moon: 0xffe8c8, moonSize: 3, ambient: 0x3a2a48, mist: 0.4,
    shades: ['oni', 'foxMask', 'lantern', 'umbrella', 'tengu', 'wall'], shadeAura: 0x9a2a3a, bossShape: 'god',
    props: { torii: true, stoneLanterns: true }, accent: '#ff8a6b',
  },
  spring: {
    skyTop: 0x040a1e, skyBottom: 0x1a3060, fog: 0x0c1830, fogDensity: 0.035,
    ground: 0x141e24, path: 0x26303a, foliage: 0x0e2230, trunk: 0x1e1c22,
    lantern: 0xffd890, moon: 0xffffff, moonSize: 6, ambient: 0x3a4a78, mist: 0.3,
    shades: ['longNeck', 'twins', 'jelly', 'tall', 'oneEye', 'foxMask'], shadeAura: 0x3a5ad0, bossShape: 'moon',
    props: { water: 0x0a1a38, mushrooms: true }, accent: '#a8c8ff',
  },
  dawn: {
    skyTop: 0x05040c, skyBottom: 0x1a1430, fog: 0x120e20, fogDensity: 0.04,
    ground: 0x1a1a1a, path: 0x2a2620, foliage: 0x121a16, trunk: 0x221a16,
    lantern: 0xffc070, moon: 0xe8e0ff, moonSize: 4, ambient: 0x302a48, mist: 0.45,
    shades: NORMAL_SHAPES, shadeAura: 0x7a30b0, bossShape: 'lord',
    props: { fewTrees: true }, accent: '#ffd27a',
    dawnTop: 0x3a5a9a, dawnBottom: 0xffb070,
  },
  /** 物語の背景: 森のはずれの村の夕暮れ（石灯籠を家の明かりに見立てる。影は出さない） */
  'village-dusk': {
    skyTop: 0x2a1c48, skyBottom: 0xff9a5a, fog: 0x6a4450, fogDensity: 0.018,
    ground: 0x2a2620, path: 0x4a3c2c, foliage: 0x1c2a1e, trunk: 0x2a1e16,
    lantern: 0xffc070, moon: 0xfff0d0, moonSize: 1.6, ambient: 0x9a7080, mist: 0.15,
    shades: [], shadeAura: 0x5230c0, bossShape: 'lord', decor: 0, noLantern: true,
    props: { stoneLanterns: true, fewTrees: true }, accent: '#ffb070',
  },
  /** 物語の背景: 夜の村（ミオがいなくなった夜） */
  'village-night': {
    skyTop: 0x02040c, skyBottom: 0x111a34, fog: 0x0a1020, fogDensity: 0.028,
    ground: 0x161a1a, path: 0x2a2a28, foliage: 0x0c1814, trunk: 0x1a1612,
    lantern: 0xffb45a, moon: 0xe8eeff, moonSize: 2.6, ambient: 0x2a3550, mist: 0.35,
    shades: [], shadeAura: 0x5230c0, bossShape: 'lord', decor: 0, noLantern: true,
    props: { stoneLanterns: true, fewTrees: true }, accent: '#ffc46b',
  },
  /** 物語の背景: 夜が明けた朝の村（エンディング） */
  'village-morning': {
    skyTop: 0x5a8ad0, skyBottom: 0xffd0a0, fog: 0xc8b8b0, fogDensity: 0.015,
    ground: 0x3a4a30, path: 0x6a5a40, foliage: 0x2a4a2c, trunk: 0x3a2a1e,
    lantern: 0xffd890, moon: 0xffffff, moonSize: 0, ambient: 0xc8c0d0, mist: 0.2,
    shades: [], shadeAura: 0x5230c0, bossShape: 'lord', decor: 0, noLantern: true,
    props: { fewTrees: true, mushrooms: true }, accent: '#ffd27a',
  },
  /** タイトル・メニューの背景（大きな月と石灯籠） */
  title: {
    skyTop: 0x030716, skyBottom: 0x1a2a50, fog: 0x0a1428, fogDensity: 0.032,
    ground: 0x141c1c, path: 0x26282a, foliage: 0x0d2024, trunk: 0x1c1816,
    lantern: 0xffc070, moon: 0xfff6e0, moonSize: 7, ambient: 0x2e3c66, mist: 0.55,
    shades: NORMAL_SHAPES, shadeAura: 0x5a40c8, bossShape: 'lord',
    props: { mushrooms: true, stoneLanterns: true }, accent: '#ffc46b',
  },
  endless: {
    skyTop: 0x020206, skyBottom: 0x0e0a1c, fog: 0x08060f, fogDensity: 0.05,
    ground: 0x111411, path: 0x22201c, foliage: 0x0c1a12, trunk: 0x1a1410,
    lantern: 0xff9a40, moon: 0xff6a5a, moonSize: 3.5, ambient: 0x261e38, mist: 0.5,
    shades: NORMAL_SHAPES, shadeAura: 0xa02a2a, bossShape: 'lord',
    props: { mushrooms: true, stoneLanterns: true }, accent: '#ff7a6b',
  },
}

/** 夜の村で、ランタンに火が入ったあと（物語の途中で切り替える） */
THEMES['village-lantern'] = { ...THEMES['village-night'], noLantern: false }

export function themeFor(id: string): Theme {
  return THEMES[id] ?? THEMES.entrance
}
