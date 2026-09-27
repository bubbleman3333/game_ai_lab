// 街（マップ）の一覧。大きさ・中心街の位置・公園・倉庫街・見た目のテーマを決める。
//
// 街は全部この設定から自動で作られる（道も建物も信号も）。新しい街を足すときは MAPS に 1 つ足すだけ。
// 見た目のテーマ（空の色・雪など）は scene/themes.ts の同じ名前のもの。

export type ThemeId = 'bay' | 'metro' | 'sunset' | 'snow'

export interface MapConfig {
  id: string
  name: string
  description: string
  /** 1 辺の区画の数（1 区画 = 94m） */
  blocks: number
  seed: number
  theme: ThemeId
  /** 高層ビル街の中心（区画の座標）と半径。r1 の内側が超高層、r2 の内側が中層 */
  downtown: { x: number; z: number; r1: number; r2: number }
  /** 倉庫街にする端（'south' なら bj が小さい側の 1〜2 列） */
  industrial: 'south' | 'north' | 'east' | 'west' | 'none'
  parks: [number, number][]
  /** 始まる時刻（時） */
  clock: number
  /** 通行人・車の多さ（1 が標準） */
  density: number
}

export const MAPS: MapConfig[] = [
  {
    id: 'bayside', name: 'ベイサイド', blocks: 12, seed: 20260927, theme: 'bay',
    description: '海に囲まれた港の街。中心に高層ビル、南に倉庫街。物語はここから始まる',
    downtown: { x: 5.5, z: 5.5, r1: 2.4, r2: 4.4 }, industrial: 'south',
    parks: [[3, 8], [8, 3], [6, 6]], clock: 17.2, density: 1,
  },
  {
    id: 'metro', name: 'メトロポリス', blocks: 18, seed: 7771, theme: 'metro',
    description: '1.7km 四方の大都会。超高層ビルが林立し、道はいつも混んでいる',
    downtown: { x: 8.5, z: 9.5, r1: 4.2, r2: 7.5 }, industrial: 'east',
    parks: [[4, 4], [13, 13], [8, 15], [15, 5], [9, 9]], clock: 21.5, density: 1.25,
  },
  {
    id: 'sunset', name: 'サンセット・ヒルズ', blocks: 16, seed: 3131, theme: 'sunset',
    description: '夕日に染まる郊外。住宅と並木道が続き、北の端に小さな繁華街',
    downtown: { x: 7.5, z: 13, r1: 1.6, r2: 3.6 }, industrial: 'west',
    parks: [[3, 3], [11, 5], [6, 8], [12, 11], [2, 12]], clock: 18.1, density: 0.85,
  },
  {
    id: 'northport', name: 'ノースハーバー', blocks: 14, seed: 9090, theme: 'snow',
    description: '雪の降る北の港町。凍った道はよく滑る。最後の舞台',
    downtown: { x: 7, z: 6, r1: 2.2, r2: 4.6 }, industrial: 'north',
    parks: [[3, 10], [10, 3], [7, 11]], clock: 22.5, density: 0.9,
  },
]

export const mapById = (id: string): MapConfig => MAPS.find((m) => m.id === id) ?? MAPS[0]
