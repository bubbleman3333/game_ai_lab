// 章の中の「場所」。波ごとに景色が移り変わり、進んでいる感じを出す（ボス戦はいちばん最後の場所）。
//
//   palette  空・霧・地面・木の色（書かなければ章の色 themes.ts のまま）。数秒かけて移り変わる
//   trees    木の多さ（dense 茂る / normal / few まばら / none 無し）
//   bamboo / reeds / rocks / torii / stoneLanterns / water  その場所にある景色
//   landmark その場所に入ったときに、前から近づいてきて通り過ぎる目印（landmarks.ts）
//
// 新しい景色は遠くから現れ、前の場所の景色は後ろへ流れ去る（ForestScene.setStage）。

import { CHAPTERS } from '../sim/chapters'
import { themeFor } from './themes'

export type Landmark = 'gate' | 'jizo' | 'bigtree' | 'bridge' | 'stairs' | 'lanterns' | 'shrine' | 'arch' | 'stones' | 'rocks'

export interface Palette {
  skyTop?: number
  skyBottom?: number
  fog?: number
  fogDensity?: number
  ground?: number
  foliage?: number
  trunk?: number
  ambient?: number
}

export interface Stage {
  name: string
  palette?: Palette
  trees: 'dense' | 'normal' | 'few' | 'none'
  bamboo?: boolean
  reeds?: boolean
  rocks?: boolean
  torii?: boolean
  stoneLanterns?: boolean
  /** 水面の色（書けば道の両わきが水になる） */
  water?: number
  landmark?: Landmark
}

export const STAGES: Record<string, Stage[]> = {
  entrance: [
    { name: '森の小径', trees: 'normal', landmark: 'gate' },
    { name: '竹林', trees: 'few', bamboo: true, palette: { foliage: 0x2c4a26, fog: 0x0c1a12, skyBottom: 0x12261c, ground: 0x1c2618 }, landmark: 'jizo' },
    { name: '古木の広場', trees: 'dense', rocks: true, palette: { foliage: 0x0c2016, fog: 0x0a1018, fogDensity: 0.05 }, landmark: 'bigtree' },
    { name: '根の巣', trees: 'dense', rocks: true, palette: { fog: 0x1a0c12, skyBottom: 0x220c18, ambient: 0x40203a, fogDensity: 0.055 } },
  ],
  marsh: [
    { name: '葦原', trees: 'normal', reeds: true, landmark: 'stones' },
    { name: '沼の浅瀬', trees: 'few', reeds: true, water: 0x0d1c1e, landmark: 'bridge' },
    { name: '霧の奥', trees: 'few', water: 0x0d1c1e, palette: { fog: 0x34484a, fogDensity: 0.09 }, landmark: 'jizo' },
    { name: '沈んだ沼', trees: 'none', water: 0x081416, palette: { fog: 0x223234, skyBottom: 0x16222a, fogDensity: 0.07 } },
  ],
  shrine: [
    { name: '苔の石段', trees: 'dense', stoneLanterns: true, landmark: 'stairs' },
    { name: '千本鳥居', trees: 'normal', torii: true, palette: { fog: 0x1e0e1a }, landmark: 'lanterns' },
    { name: '境内', trees: 'few', stoneLanterns: true, landmark: 'shrine' },
    { name: '呑まれた社', trees: 'few', stoneLanterns: true, palette: { skyTop: 0x14040a, skyBottom: 0x3a0a14, fog: 0x2a0a14, ambient: 0x4a2030 } },
  ],
  spring: [
    { name: '月の小道', trees: 'normal', landmark: 'arch' },
    { name: '泉のほとり', trees: 'few', water: 0x0a1a38, rocks: true, landmark: 'stones' },
    { name: '月映しの泉', trees: 'few', water: 0x0a1a38, palette: { skyTop: 0x06102a, skyBottom: 0x2a4a80, fogDensity: 0.028 } },
  ],
  dawn: [
    { name: '岩の斜面', trees: 'few', rocks: true, landmark: 'rocks' },
    { name: '丘の上', trees: 'none', rocks: true, landmark: 'bigtree' },
    { name: '夜明けの頂', trees: 'none' },
  ],
}

/** 終わらない夜は、全部の章の場所（ボスの場所は除く）を順にめぐる */
const ENDLESS_STAGES: Stage[] = CHAPTERS.flatMap((c) => (STAGES[c.id] ?? []).slice(0, -1))

/** 場所の一覧。章でない背景（タイトル・村）は、その背景の景色そのままの場所が 1 つ */
export function stagesFor(themeId: string): Stage[] {
  if (themeId === 'endless') return ENDLESS_STAGES
  const list = STAGES[themeId]
  if (list) return list
  const t = themeFor(themeId)
  return [{
    name: '', trees: t.props.fewTrees ? 'few' : 'normal', torii: t.props.torii, stoneLanterns: t.props.stoneLanterns, water: t.props.water,
  }]
}

/** 何番目の波（ボス戦なら boss = true）が、どの場所か */
export function stageIndexFor(themeId: string, wave: number, boss: boolean): number {
  const list = stagesFor(themeId)
  if (themeId === 'endless') return wave % list.length
  if (boss) return list.length - 1
  return Math.min(wave, list.length - 2)
}
