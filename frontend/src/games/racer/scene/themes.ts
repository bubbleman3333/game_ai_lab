// コースの「景色」の設定。コースの JSON の "theme" でどれを使うか決まる。
// 見た目だけの話なので、ここは Python 版には存在しない（AI の学習には関係しない）。
//
// 新しい景色を足したいときは、この表に 1 つ足して、コースの JSON の "theme" にその名前を書く。

/** 色は 0xRRGGBB の数値で書く（three.js の決まり） */
export interface Theme {
  /** 空の上のほうの色と、地平線ぎわの色。この 2 色でグラデーションになる */
  skyTop: number
  skyBottom: number
  /** 遠くがかすむ色と、かすみ始める距離・見えなくなる距離（m） */
  fog: number
  fogNear: number
  fogFar: number
  /** 地面（コースの外に広がる大地）の色 */
  ground: number
  /** 遠景の山の色 */
  hills: number
  /** 太陽（平行光）の色・強さと、空から来る光（環境光）の色・強さ */
  sunColor: number
  sunStrength: number
  /** 太陽の向き。y を小さくすると低い位置から差して、影が長くなる */
  sunDir: [number, number, number]
  ambientColor: number
  ambientStrength: number
  /** 道の色（アスファルト）と、道の端の縁石の 2 色 */
  road: number
  kerbA: number
  kerbB: number
  /** ガードレールの色。neon のように光らせたいときは glow を true にする */
  rail: number
  railGlow: boolean
  /**
   * コースの外に広がる大地の作り方。
   *   follow = 道の高さに沿って盛り上がる（丘や谷に見える）
   *   flat   = 平らなまま。道が高いところは橋脚で支える高架に見える
   */
  terrain: 'follow' | 'flat'
  /** コース脇に並べる飾り */
  props: PropSpec[]
  /** 画面全体の雰囲気（HUD の色に使う CSS の色） */
  accent: string
}

/** コース脇に並べる飾り 1 種類ぶん */
export interface PropSpec {
  /** 形。tree = 木、cactus = サボテン、rock = 岩、lamp = 街灯、tower = ビル */
  shape: 'tree' | 'cactus' | 'rock' | 'lamp' | 'tower'
  color: number
  /** もう 1 色使う形（木の葉・街灯の灯り）のための色 */
  color2?: number
  /** 何 m おきに置くか */
  every: number
  /** 道の端から何 m 外に置くか（左右の両方に置かれる） */
  offset: number
  /** 大きさのばらつき（1 を中心に ±この割合） */
  vary: number
  /** 大きさの基準 */
  scale: number
  /** 光らせるか（夜のコース用） */
  glow?: boolean
}

export const THEMES: Record<string, Theme> = {
  // 昼の草原。素直に明るく、影がはっきり出る
  meadow: {
    skyTop: 0x2f7fd0, skyBottom: 0xbfe4ff,
    fog: 0xbfe4ff, fogNear: 260, fogFar: 900,
    ground: 0x4e8c3a, hills: 0x3d6f4a,
    sunColor: 0xfff4e0, sunStrength: 2.1, sunDir: [-0.5, 0.85, 0.35],
    ambientColor: 0x9fc4e8, ambientStrength: 0.75,
    road: 0x50535c, kerbA: 0xe8e8e8, kerbB: 0xd24b3c,
    rail: 0xd8dde4, railGlow: false,
    terrain: 'follow',
    accent: '#5fd07a',
    props: [
      { shape: 'tree', color: 0x6b4a2f, color2: 0x3f8c46, every: 17, offset: 7, vary: 0.35, scale: 5.5 },
      { shape: 'tree', color: 0x6b4a2f, color2: 0x54a355, every: 29, offset: 20, vary: 0.45, scale: 7 },
      { shape: 'rock', color: 0x8b8b84, every: 43, offset: 12, vary: 0.5, scale: 1.8 },
    ],
  },

  // 夕暮れの砂漠。太陽を低くして影を長く伸ばす（ジャンプがよく映える）
  desert: {
    skyTop: 0x2a2352, skyBottom: 0xff9b52,
    fog: 0xe5915c, fogNear: 200, fogFar: 820,
    ground: 0xc98b52, hills: 0x8a5436,
    sunColor: 0xffb070, sunStrength: 2.4, sunDir: [-0.85, 0.22, -0.4],
    ambientColor: 0x7a5a86, ambientStrength: 0.7,
    road: 0x6a5647, kerbA: 0xf2e2c4, kerbB: 0xb5462f,
    rail: 0xe6c9a0, railGlow: false,
    terrain: 'follow',
    accent: '#ffa95e',
    props: [
      { shape: 'cactus', color: 0x4f7a43, every: 23, offset: 8, vary: 0.4, scale: 4.5 },
      { shape: 'rock', color: 0xa97a5a, every: 19, offset: 10, vary: 0.6, scale: 2.4 },
      { shape: 'rock', color: 0x8f6a45, every: 37, offset: 26, vary: 0.8, scale: 5 },
    ],
  },

  // 夜のネオン。光るものだけが見える。霧を濃くして奥行きを出す
  neon: {
    skyTop: 0x05030f, skyBottom: 0x1b1040,
    fog: 0x120a2a, fogNear: 120, fogFar: 620,
    ground: 0x0d0a1c, hills: 0x171033,
    sunColor: 0x9ab0ff, sunStrength: 1.15, sunDir: [-0.3, 0.7, -0.6],
    ambientColor: 0x4a3a86, ambientStrength: 0.8,
    road: 0x2e2a52, kerbA: 0x21f0ff, kerbB: 0xff3ea5,
    rail: 0x2ef0ff, railGlow: true,
    terrain: 'flat',
    accent: '#2ef0ff',
    props: [
      { shape: 'lamp', color: 0x2a2a3a, color2: 0xff3ea5, every: 21, offset: 6, vary: 0.15, scale: 7, glow: true },
      { shape: 'tower', color: 0x120f26, color2: 0x21f0ff, every: 47, offset: 34, vary: 0.9, scale: 26, glow: true },
      { shape: 'tower', color: 0x160f2e, color2: 0xff3ea5, every: 71, offset: 60, vary: 1.1, scale: 38, glow: true },
    ],
  },
}

export const themeFor = (name: string): Theme => THEMES[name] ?? THEMES.meadow
