// 街の地図。碁盤の目の道路・区画・建物・街灯・信号・木を、種つきの乱数で並べる。
// three.js にも React にも依存しない（描画は scene/buildCity.ts、当たり判定はここ）。
//
// 座標は three.js と同じ: x・z が地面、y が上。単位はメートル。街の中心が原点。
//
//   道路の中心線は x = nodeX(i)、z = nodeX(j)（i, j = 0..BLOCKS）の格子。
//   道路と道路のあいだが 1 つの「区画（ブロック）」で、外側から
//     車道（片側 7.5m） → 歩道（4.5m） → 建物を建てる土地（70m 四方）
//   の順に並ぶ。区画の番号 (bi, bj) は 0..BLOCKS-1。
//
// 車は左側通行（日本と同じ）。片側 2 車線。

import { makeRng, range, pick, chance, type Rng } from './rng'
import { MAPS, type MapConfig } from './maps'

/** 1 辺の区画の数。街ごとに違うので、CityMap を作るときに setCitySize() で変わる */
export let BLOCKS = 12
export const ROAD_HALF = 7.5 // 車道の半分の幅（中心線から縁石まで）
export const SIDEWALK = 4.5
export const LOT_HALF = 35 // 建物を建てる土地の半分の幅
export const BLOCK_HALF = LOT_HALF + SIDEWALK // 区画の中心から縁石まで
export const PITCH = 2 * (ROAD_HALF + BLOCK_HALF) // 道路と道路の間隔（94m）
export let HALF_CITY = (BLOCKS * PITCH) / 2
export let NODES = BLOCKS + 1
/** 歩道のまんなか（区画の中心からの距離） */
export const SIDEWALK_MID = LOT_HALF + SIDEWALK / 2
/** 中心線から各車線の中心までの距離（内側・外側） */
export const LANE_OFFSETS = [2.0, 5.5] as const
/** 交差点の中心から停止線まで。停止線の手前に横断歩道がある */
export const STOP_DIST = 14
/** 交差点の中心から横断歩道の中心まで（歩道のまんなかの延長上） */
export const CROSSWALK_DIST = PITCH / 2 - (LOT_HALF + SIDEWALK / 2)
/** 街の外周の護岸（ここから外は海） */
export let SEAWALL = HALF_CITY + ROAD_HALF + SIDEWALK

/**
 * 街の大きさを切り替える。上の BLOCKS・HALF_CITY・NODES・SEAWALL は、import した側でも
 * この値に変わる（ES モジュールの export let は「生きた」値なので）。
 * 同時に動かす街は 1 つだけ、という前提。
 */
export function setCitySize(blocks: number): void {
  BLOCKS = blocks
  HALF_CITY = (BLOCKS * PITCH) / 2
  NODES = BLOCKS + 1
  SEAWALL = HALF_CITY + ROAD_HALF + SIDEWALK
}
export const CURB_HEIGHT = 0.15

export const nodeX = (i: number) => i * PITCH - HALF_CITY
export const blockCenter = (b: number) => (b + 0.5) * PITCH - HALF_CITY

/** 進む向き。0: +x、1: +z、2: −x、3: −z */
export const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
/** 進む向き d から見て左（左側通行なので車線はこちら側）。右は (−dz, dx) */
export const leftOf = (dx: number, dz: number): [number, number] => [dz, -dx]

export type District = 'downtown' | 'midtown' | 'residential' | 'industrial' | 'park'
export type Style = 'glass' | 'office' | 'concrete' | 'brick' | 'warehouse' | 'house'

export interface Building {
  x0: number; z0: number; x1: number; z1: number
  /** 壁の高さ（家は屋根の三角を含まない） */
  h: number
  style: Style
  /** 1 階を店にするか */
  shop: boolean
  roof: 'flat' | 'gable'
  /** 窓の点き方などを散らす種 */
  seed: number
}

export type PropKind = 'lamp' | 'tree' | 'signal' | 'pole'
export interface Prop {
  kind: PropKind
  x: number; z: number
  /** 当たり判定の半径 */
  r: number
  /** 向き（信号はどちらを向くか、街灯は腕をどちらへ伸ばすか） */
  yaw: number
  /** 壊れる（倒れる）か */
  breakable: boolean
  /** 信号: どの交差点の、どちら向きの車線のためか */
  node?: [number, number]
  axis?: 0 | 1
  /** 大きさのばらつき（木） */
  scale: number
}

export interface Block {
  bi: number; bj: number
  cx: number; cz: number
  district: District
}

export interface Box { x0: number; z0: number; x1: number; z1: number }

export type Surface = 'road' | 'sidewalk' | 'lot' | 'grass' | 'water'

const CELL = 16

/** 地区の決め方: 中心ほど高いビル、端の 1〜2 列は倉庫街、いくつかは公園 */
function districtOf(cfg: MapConfig, bi: number, bj: number): District {
  if (cfg.parks.some(([x, z]) => x === bi && z === bj)) return 'park'
  const n = cfg.blocks
  const edge = cfg.industrial === 'south' ? bj : cfg.industrial === 'north' ? n - 1 - bj
    : cfg.industrial === 'west' ? bi : cfg.industrial === 'east' ? n - 1 - bi : 99
  const along = cfg.industrial === 'south' || cfg.industrial === 'north' ? bi : bj
  if (edge === 0 || (edge === 1 && along >= n * 0.6)) return 'industrial'
  const r = Math.hypot(bi - cfg.downtown.x, bj - cfg.downtown.z)
  if (r < cfg.downtown.r1) return 'downtown'
  if (r < cfg.downtown.r2) return 'midtown'
  return 'residential'
}

export class CityMap {
  readonly blocks: Block[] = []
  readonly buildings: Building[] = []
  readonly props: Prop[] = []
  /** 公園の中の散歩道（見た目だけ） */
  readonly paths: Box[] = []
  /**
   * 植え込み（見た目だけ。当たり判定なし）。
   *   box   繁華街の歩道のコンクリートの鉢植え
   *   hedge 住宅の敷地ぞいの生け垣
   *   bush  公園の茂み
   */
  /**
   * 目印になる建物（公園に置く）。tower = 電波塔、shrine = 神社、pond = 池と噴水。
   * 見た目は scene/landmarks.ts、当たり判定の箱は solids
   */
  readonly landmarks: { kind: 'tower' | 'shrine' | 'pond'; x: number; z: number }[] = []
  /** 建物ではないが、ぶつかる物（電波塔の脚・鳥居の柱・社殿） */
  readonly solids: Box[] = []
  /** 電線の張られた電柱の並び（住宅街）。見た目用に、つながる順に並べたもの */
  readonly wireRuns: [number, number][][] = []
  readonly planters: { x: number; z: number; yaw: number; kind: 'box' | 'hedge' | 'bush'; scale: number; variant: number }[] = []
  /** 護岸（外周の壁） */
  readonly walls: Box[] = []
  private grid: { b: number[]; p: number[]; s: number[] }[]
  private gridHalf: number
  private gridN: number
  readonly config: MapConfig
  /** 中心街がいちばん高くなる場所（区画の座標）と半径 */
  private dt: MapConfig['downtown']

  constructor(config: MapConfig = MAPS[0]) {
    this.config = config
    setCitySize(config.blocks)
    this.dt = config.downtown
    this.gridHalf = Math.ceil((SEAWALL + 20) / CELL)
    this.gridN = this.gridHalf * 2
    const rng = makeRng(config.seed)
    for (let bj = 0; bj < BLOCKS; bj++) {
      for (let bi = 0; bi < BLOCKS; bi++) {
        const block: Block = { bi, bj, cx: blockCenter(bi), cz: blockCenter(bj), district: districtOf(config, bi, bj) }
        this.blocks.push(block)
        this.fillBlock(block, rng)
        this.streetFurniture(block, rng)
      }
    }
    this.placeSignals()
    this.placePlanters(makeRng(config.seed ^ 0x77))
    this.placeLandmarks()
    this.placePoles()
    const t = 6
    const s = SEAWALL
    this.walls.push(
      { x0: -s - t, z0: -s - t, x1: s + t, z1: -s },
      { x0: -s - t, z0: s, x1: s + t, z1: s + t },
      { x0: -s - t, z0: -s, x1: -s, z1: s },
      { x0: s, z0: -s, x1: s + t, z1: s },
    )
    this.grid = Array.from({ length: this.gridN * this.gridN }, () => ({ b: [], p: [], s: [] }))
    this.buildings.forEach((b, i) => this.eachCell(b.x0, b.z0, b.x1, b.z1, (c) => c.b.push(i)))
    this.solids.forEach((b, i) => this.eachCell(b.x0, b.z0, b.x1, b.z1, (c) => c.s.push(i)))
    this.props.forEach((p, i) => this.eachCell(p.x - p.r, p.z - p.r, p.x + p.r, p.z + p.r, (c) => c.p.push(i)))
  }

  // --- 組み立て ---------------------------------------------------------------

  private addBuilding(block: Block, lx0: number, lz0: number, lx1: number, lz1: number,
                      h: number, style: Style, shop: boolean, rng: Rng, roof: 'flat' | 'gable' = 'flat') {
    this.buildings.push({
      x0: block.cx + lx0, z0: block.cz + lz0, x1: block.cx + lx1, z1: block.cz + lz1,
      h, style, shop, roof, seed: Math.floor(rng() * 1e9),
    })
  }

  /** 土地を n×m に割って、それぞれに建物を建てる */
  private subdivide(n: number, m: number, make: (x0: number, z0: number, x1: number, z1: number) => void) {
    const w = (LOT_HALF * 2) / n
    const d = (LOT_HALF * 2) / m
    for (let a = 0; a < n; a++) {
      for (let c = 0; c < m; c++) {
        make(-LOT_HALF + a * w, -LOT_HALF + c * d, -LOT_HALF + (a + 1) * w, -LOT_HALF + (c + 1) * d)
      }
    }
  }

  private fillBlock(block: Block, rng: Rng) {
    const { district } = block
    if (district === 'park') {
      // 十字の散歩道と、道に沿った木
      this.paths.push({ x0: block.cx - 2, z0: block.cz - LOT_HALF, x1: block.cx + 2, z1: block.cz + LOT_HALF })
      this.paths.push({ x0: block.cx - LOT_HALF, z0: block.cz - 2, x1: block.cx + LOT_HALF, z1: block.cz + 2 })
      for (let k = 0; k < 46; k++) {
        const x = range(rng, -LOT_HALF + 3, LOT_HALF - 3)
        const z = range(rng, -LOT_HALF + 3, LOT_HALF - 3)
        if (Math.abs(x) < 5 || Math.abs(z) < 5) continue
        this.addTree(block.cx + x, block.cz + z, rng, range(rng, 0.9, 1.5))
      }
      return
    }
    if (district === 'downtown') {
      // 大きなビルを 1〜4 棟。中心に近いほど高い
      const r = Math.hypot(block.bi - this.dt.x, block.bj - this.dt.z)
      const tall = 1.4 - r / this.dt.r1
      const split = pick(rng, [[1, 1], [2, 1], [1, 2], [2, 2]] as const)
      this.subdivide(split[0], split[1], (x0, z0, x1, z1) => {
        const m = range(rng, 1, 3.5)
        const h = range(rng, 40, 90) + tall * range(rng, 30, 90)
        this.addBuilding(block, x0 + m, z0 + m, x1 - m, z1 - m, h, chance(rng, 0.6) ? 'glass' : 'office', true, rng)
      })
      return
    }
    if (district === 'midtown') {
      const split = pick(rng, [[2, 2], [3, 2], [2, 3]] as const)
      this.subdivide(split[0], split[1], (x0, z0, x1, z1) => {
        const m = range(rng, 1, 3)
        const style = pick(rng, ['office', 'concrete', 'brick', 'glass'] as const)
        this.addBuilding(block, x0 + m, z0 + m, x1 - m, z1 - m, range(rng, 14, 46), style, chance(rng, 0.75), rng)
      })
      return
    }
    if (district === 'industrial') {
      const split = pick(rng, [[1, 2], [2, 1], [2, 2]] as const)
      this.subdivide(split[0], split[1], (x0, z0, x1, z1) => {
        const m = range(rng, 3, 6)
        this.addBuilding(block, x0 + m, z0 + m, x1 - m, z1 - m, range(rng, 8, 14), 'warehouse', false, rng)
      })
      return
    }
    // 住宅街: 3×3 に割って、家・低いマンション・空き地（庭）
    this.subdivide(3, 3, (x0, z0, x1, z1) => {
      const roll = rng()
      if (roll < 0.12) return // 空き地
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      if (roll < 0.62) {
        const w = range(rng, 5, 7)
        const d = range(rng, 5.5, 7.5)
        this.addBuilding(block, cx - w, cz - d, cx + w, cz + d, range(rng, 5.5, 7), 'house', false, rng, 'gable')
      } else {
        const m = range(rng, 1.5, 3)
        const floors = Math.floor(range(rng, 3, 7))
        this.addBuilding(block, x0 + m, z0 + m, x1 - m, z1 - m, floors * 3.2, chance(rng, 0.5) ? 'brick' : 'concrete',
                         chance(rng, 0.3), rng)
      }
    })
  }

  private addTree(x: number, z: number, rng: Rng, scale = 1) {
    this.props.push({ kind: 'tree', x, z, r: 0.45 * scale, yaw: rng() * Math.PI * 2, breakable: false, scale })
  }

  /** 街灯と街路樹。区画の 4 辺の縁石ぞいに並べる */
  private streetFurniture(block: Block, rng: Rng) {
    const edge = BLOCK_HALF - 0.7
    for (let side = 0; side < 4; side++) {
      const [nx, nz] = DIRS[side] // 区画の中心から見て外向き
      const [tx, tz] = [-nz, nx]
      for (const t of [-24, 0, 24]) {
        this.props.push({
          kind: 'lamp', x: block.cx + nx * edge + tx * t, z: block.cz + nz * edge + tz * t,
          r: 0.18, yaw: Math.atan2(nx, nz), breakable: true, scale: 1,
        })
      }
      if (block.district === 'residential' || block.district === 'midtown') {
        for (const t of [-12, 12]) {
          if (chance(rng, 0.25)) continue
          this.addTree(block.cx + nx * (edge - 0.3) + tx * t, block.cz + nz * (edge - 0.3) + tz * t, rng, range(rng, 0.8, 1.1))
        }
      }
    }
  }

  /**
   * 公園に目印を置く。中心街にいちばん近い公園に電波塔、次に神社、その次に池。
   * 公園が足りなければ置けるぶんだけ
   */
  private placeLandmarks() {
    const parks = this.blocks.filter((b) => b.district === 'park')
      .sort((a, b) => Math.hypot(a.bi - this.dt.x, a.bj - this.dt.z) - Math.hypot(b.bi - this.dt.x, b.bj - this.dt.z))
    const kinds = ['tower', 'shrine', 'pond'] as const
    parks.slice(0, 3).forEach((b, k) => {
      const kind = kinds[k]
      // 公園の十字の散歩道を避けて、4 分の 1 の区画の真ん中に置く
      const x = b.cx + 17, z = b.cz + 17
      this.landmarks.push({ kind, x, z })
      if (kind === 'tower') {
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const lx = x + sx * 9, lz = z + sz * 9
          this.solids.push({ x0: lx - 1.2, z0: lz - 1.2, x1: lx + 1.2, z1: lz + 1.2 })
        }
      } else if (kind === 'shrine') {
        // 社殿と、その前の鳥居の 2 本の柱
        this.solids.push({ x0: x - 5, z0: z + 2, x1: x + 5, z1: z + 10 })
        for (const sx of [-2.4, 2.4]) this.solids.push({ x0: x + sx - 0.35, z0: z - 12.35, x1: x + sx + 0.35, z1: z - 11.65 })
      }
    })
  }

  /** 住宅街の電柱。道路の片側に 30m おきに立て、電線でつなぐ */
  private placePoles() {
    for (const block of this.blocks) {
      if (block.district !== 'residential') continue
      const edge = BLOCK_HALF - 0.45
      for (const side of [0, 1]) { // 区画の +x 側と +z 側の道路ぞい（隣の区画と重ならないように片側だけ）
        const [nx, nz] = DIRS[side]
        const [tx, tz] = [-nz, nx]
        const run: [number, number][] = []
        for (const t of [-36, -12, 12, 36]) {
          const x = block.cx + nx * edge + tx * t, z = block.cz + nz * edge + tz * t
          run.push([x, z])
          this.props.push({ kind: 'pole', x, z, r: 0.2, yaw: Math.atan2(nx, nz), breakable: false, scale: 1 })
        }
        this.wireRuns.push(run)
      }
    }
  }

  /** 植え込みを並べる（別の乱数を使うので、建物の並びは変わらない） */
  private placePlanters(rng: Rng) {
    const edge = LOT_HALF + 0.9
    for (const block of this.blocks) {
      const d = block.district
      if (d === 'park') {
        for (let k = 0; k < 40; k++) {
          const x = range(rng, -LOT_HALF + 2, LOT_HALF - 2), z = range(rng, -LOT_HALF + 2, LOT_HALF - 2)
          if (Math.abs(x) < 3.5 || Math.abs(z) < 3.5) continue
          this.planters.push({ x: block.cx + x, z: block.cz + z, yaw: rng() * 6.28, kind: 'bush', scale: range(rng, 0.9, 1.8), variant: Math.floor(rng() * 3) })
        }
        continue
      }
      if (d === 'industrial') continue
      for (let side = 0; side < 4; side++) {
        const [nx, nz] = DIRS[side]
        const [tx, tz] = [-nz, nx]
        if (d === 'residential') {
          // 敷地のふちに沿って生け垣（ところどころ途切れる）
          for (let t = -LOT_HALF + 1; t <= LOT_HALF - 1; t += 1.6) {
            if (chance(rng, 0.3)) continue
            this.planters.push({
              x: block.cx + nx * (LOT_HALF - 0.6) + tx * t, z: block.cz + nz * (LOT_HALF - 0.6) + tz * t,
              yaw: rng() * 6.28, kind: 'hedge', scale: range(rng, 0.8, 1.1), variant: Math.floor(rng() * 3),
            })
          }
          continue
        }
        // 繁華街・オフィス街: 建物の前の歩道にコンクリートの鉢植え
        for (let t = -30; t <= 30; t += 10) {
          if (chance(rng, 0.35)) continue
          this.planters.push({
            x: block.cx + nx * edge + tx * t, z: block.cz + nz * edge + tz * t,
            yaw: Math.atan2(nx, nz), kind: 'box', scale: range(rng, 0.9, 1.1), variant: Math.floor(rng() * 3),
          })
        }
      }
    }
  }

  /** 信号。交差点に入ってくる向きごとに 1 本、向こう側の左の角に立てる */
  private placeSignals() {
    const c = ROAD_HALF + 0.9
    for (let j = 0; j < NODES; j++) {
      for (let i = 0; i < NODES; i++) {
        for (let d = 0; d < 4; d++) {
          const [dx, dz] = DIRS[d]
          // 手前の交差点が無い（街の外から来る）向きには要らない
          const fi = i - dx
          const fj = j - dz
          if (fi < 0 || fj < 0 || fi >= NODES || fj >= NODES) continue
          const [lx, lz] = leftOf(dx, dz)
          this.props.push({
            kind: 'signal', x: nodeX(i) + dx * c + lx * c, z: nodeX(j) + dz * c + lz * c,
            r: 0.22, yaw: Math.atan2(-dx, -dz), breakable: false, node: [i, j], axis: dx !== 0 ? 0 : 1, scale: 1,
          })
        }
      }
    }
  }

  // --- 検索 ---------------------------------------------------------------------

  private cellIndex(x: number, z: number): number {
    const cx = Math.floor(x / CELL) + this.gridHalf
    const cz = Math.floor(z / CELL) + this.gridHalf
    if (cx < 0 || cz < 0 || cx >= this.gridN || cz >= this.gridN) return -1
    return cz * this.gridN + cx
  }

  private eachCell(x0: number, z0: number, x1: number, z1: number, fn: (c: { b: number[]; p: number[]; s: number[] }) => void) {
    const h = this.gridHalf, n = this.gridN
    const a0 = Math.max(Math.floor(x0 / CELL) + h, 0)
    const a1 = Math.min(Math.floor(x1 / CELL) + h, n - 1)
    const c0 = Math.max(Math.floor(z0 / CELL) + h, 0)
    const c1 = Math.min(Math.floor(z1 / CELL) + h, n - 1)
    for (let c = c0; c <= c1; c++) for (let a = a0; a <= a1; a++) fn(this.grid[c * n + a])
  }

  /** (x, z) の半径 r 以内にかかる建物と小物の番号。同じものが 2 回入らないように印をつける */
  private stamp = 1
  private bStamp: number[] = []
  private pStamp: number[] = []
  private sStamp: number[] = []
  near(x: number, z: number, r: number, buildings: number[], props: number[], solids?: number[]): void {
    buildings.length = 0
    props.length = 0
    if (solids) solids.length = 0
    this.stamp++
    this.eachCell(x - r, z - r, x + r, z + r, (c) => {
      if (solids) for (const b of c.s) if (this.sStamp[b] !== this.stamp) { this.sStamp[b] = this.stamp; solids.push(b) }
      for (const b of c.b) if (this.bStamp[b] !== this.stamp) { this.bStamp[b] = this.stamp; buildings.push(b) }
      for (const p of c.p) if (this.pStamp[p] !== this.stamp) { this.pStamp[p] = this.stamp; props.push(p) }
    })
  }

  /** その点が建物の中か */
  insideBuilding(x: number, z: number, pad = 0): boolean {
    const i = this.cellIndex(x, z)
    if (i < 0) return true
    for (const b of this.grid[i].b) {
      const B = this.buildings[b]
      if (x > B.x0 - pad && x < B.x1 + pad && z > B.z0 - pad && z < B.z1 + pad) return true
    }
    for (const b of this.grid[i].s) {
      const B = this.solids[b]
      if (x > B.x0 - pad && x < B.x1 + pad && z > B.z0 - pad && z < B.z1 + pad) return true
    }
    return Math.abs(x) > SEAWALL || Math.abs(z) > SEAWALL
  }

  /** 2 点のあいだに建物が無いか（警察が見えているかの判断） */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az)
    const n = Math.ceil(len / 3)
    for (let k = 1; k < n; k++) {
      const t = k / n
      if (this.insideBuilding(ax + (bx - ax) * t, az + (bz - az) * t)) return false
    }
    return true
  }

  /** いちばん近い道路の中心線の番号（0..BLOCKS）と、そこからの距離 */
  static nearestLine(v: number): [number, number] {
    const i = Math.min(Math.max(Math.round((v + HALF_CITY) / PITCH), 0), BLOCKS)
    return [i, Math.abs(v - nodeX(i))]
  }

  surface(x: number, z: number): Surface {
    if (Math.abs(x) > SEAWALL || Math.abs(z) > SEAWALL) return 'water'
    const [, dx] = CityMap.nearestLine(x)
    const [, dz] = CityMap.nearestLine(z)
    const d = Math.min(dx, dz)
    if (d < ROAD_HALF) return 'road'
    if (d < ROAD_HALF + SIDEWALK) return 'sidewalk'
    const block = this.blockAt(x, z)
    return block?.district === 'park' ? 'grass' : 'lot'
  }

  blockAt(x: number, z: number): Block | null {
    const bi = Math.floor((x + HALF_CITY) / PITCH)
    const bj = Math.floor((z + HALF_CITY) / PITCH)
    if (bi < 0 || bj < 0 || bi >= BLOCKS || bj >= BLOCKS) return null
    return this.blocks[bj * BLOCKS + bi]
  }

  /**
   * 信号の色。z 方向に進む車と x 方向に進む車が交互に青になる。
   * 交差点ごとに時間をずらして、隣どうしが同時に切り替わらないようにしている。
   */
  static light(i: number, j: number, axis: 0 | 1, time: number): 'green' | 'yellow' | 'red' {
    const t = (((time + (i * 5 + j * 3) * 1.7) % CYCLE) + CYCLE) % CYCLE
    const tt = axis === 1 ? t : (t + CYCLE / 2) % CYCLE
    if (tt < GREEN) return 'green'
    if (tt < GREEN + YELLOW) return 'yellow'
    return 'red'
  }
}

/** 信号の 1 周（秒）と、そのうち青・黄の長さ。残りは赤（反対向きの青 + 全部赤の間） */
export const CYCLE = 26
export const GREEN = 10
export const YELLOW = 2.5
