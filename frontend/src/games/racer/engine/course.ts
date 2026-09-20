// コース（中心線）の読み込みと、コース上の位置の計算。
// backend/games/racer/course.py と同じ式・同じ順番で計算する
// （shared/fixtures/racer/engine_cases.json で一致を確認）。React・DOM には依存しない。
//
// 座標は three.js と同じ向き: x = 右、y = 上、z = 奥。単位はメートル。
// 向き（yaw）は「前を向くベクトルが (sin yaw, 0, cos yaw)」。yaw = 0 が +z の向き。
// 運転者から見た右を向くベクトルは (-cos yaw, 0, sin yaw)。
// （右手系で上が +y・前が +z のとき、右 = 前 × 上 = -x。つまり画面の右はワールドの -x。
//  ここを取り違えると、ハンドルを右に切ったのに画面では左へ曲がる。）
// 右へ曲がると yaw は減り、左へ曲がると増える。
//
// コースを足すときは shared/courses/ に JSON を 1 つ置くだけでよい（ここは何も変えなくてよい）。

export const SUB = 16
export const SPACING = 1.0
const BANK_GAIN = 6.0
const BANK_MAX = 0.28

export const KIND_NORMAL = 0
export const KIND_BOOST = 1
export const KIND_DIRT = 2
export const KIND_RAMP = 3
export const KIND_GAP = 4
const KIND_BY_NAME: Record<string, number> = {
  normal: KIND_NORMAL, boost: KIND_BOOST, dirt: KIND_DIRT, ramp: KIND_RAMP, gap: KIND_GAP,
}

const DEFAULT_RAMP_LENGTH = 26.0
const DEFAULT_RAMP_HEIGHT = 6.0

export interface Waypoint { x: number; z: number; y?: number; width?: number; bank?: number }
export interface Feature {
  kind: string
  from: number
  to?: number
  offset?: number
  length?: number
  height?: number
}
export interface CourseJson {
  id: string
  name?: string
  theme?: string
  description?: string
  laps?: number
  width?: number
  waypoints: Waypoint[]
  features?: Feature[]
}

export interface Course {
  id: string
  name: string
  theme: string
  description: string
  laps: number
  n: number
  spacing: number
  length: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  width: Float64Array
  /** 道の傾き。正なら運転者から見て右側が下がる（右コーナーの向き） */
  bank: Float64Array
  heading: Float64Array
  kind: Int32Array
  safe: Int32Array
}

/** Python の % と同じで、結果が必ず 0 以上になる余り */
export const mod = (a: number, n: number) => ((a % n) + n) % n
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
export const wrapAngle = (a: number) => mod(a + Math.PI, 2 * Math.PI) - Math.PI

/** p1 と p2 の間を、前後の点 p0・p3 も見ながら滑らかにつなぐ（centripetal Catmull-Rom 曲線） */
function spline(v0: number, v1: number, v2: number, v3: number,
                t0: number, t1: number, t2: number, t3: number, t: number): number {
  const a1 = ((t1 - t) * v0 + (t - t0) * v1) / (t1 - t0)
  const a2 = ((t2 - t) * v1 + (t - t1) * v2) / (t2 - t1)
  const a3 = ((t3 - t) * v2 + (t - t2) * v3) / (t3 - t2)
  const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0)
  const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1)
  return ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1)
}

function knotGap(a: Waypoint, b: Waypoint): number {
  const d = Math.sqrt((b.x - a.x) ** 2 + ((b.y ?? 0) - (a.y ?? 0)) ** 2 + (b.z - a.z) ** 2)
  return Math.sqrt(Math.max(d, 1e-6))
}

type Pt = [number, number, number, number, number] // x, y, z, 幅, 追加のバンク

function polyline(wps: Waypoint[], defaultWidth: number): { pts: Pt[]; wpIndex: number[] } {
  const m = wps.length
  const pts: Pt[] = []
  const wpIndex: number[] = []
  for (let i = 0; i < m; i++) {
    const p0 = wps[mod(i - 1, m)], p1 = wps[i], p2 = wps[mod(i + 1, m)], p3 = wps[mod(i + 2, m)]
    const t0 = 0
    const t1 = t0 + knotGap(p0, p1)
    const t2 = t1 + knotGap(p1, p2)
    const t3 = t2 + knotGap(p2, p3)
    wpIndex.push(pts.length)
    for (let k = 0; k < SUB; k++) {
      const f = k / SUB
      const t = t1 + (t2 - t1) * f
      const x = spline(p0.x, p1.x, p2.x, p3.x, t0, t1, t2, t3, t)
      const y = spline(p0.y ?? 0, p1.y ?? 0, p2.y ?? 0, p3.y ?? 0, t0, t1, t2, t3, t)
      const z = spline(p0.z, p1.z, p2.z, p3.z, t0, t1, t2, t3, t)
      const w1 = p1.width ?? defaultWidth, w2 = p2.width ?? defaultWidth
      const b1 = p1.bank ?? 0, b2 = p2.bank ?? 0
      pts.push([x, y, z, w1 + (w2 - w1) * f, b1 + (b2 - b1) * f])
    }
  }
  return { pts, wpIndex }
}

function resample(pts: Pt[]): { out: Pt[]; spacing: number; total: number; cum: number[] } {
  const m = pts.length
  const cum = [0]
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % m]
    cum.push(cum[cum.length - 1]
      + Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2))
  }
  const total = cum[m]
  const n = Math.max(8, Math.round(total / SPACING))
  const spacing = total / n
  const out: Pt[] = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const d = k * spacing
    while (j < m - 1 && cum[j + 1] <= d) j++
    const seg = cum[j + 1] - cum[j]
    const t = seg > 1e-9 ? (d - cum[j]) / seg : 0
    const a = pts[j], b = pts[(j + 1) % m]
    out.push([0, 1, 2, 3, 4].map((c) => a[c] + (b[c] - a[c]) * t) as Pt)
  }
  return { out, spacing, total, cum }
}

/**
 * コースの仕掛け（加速パネル・砂・ジャンプ台・途切れ）を、並べ直した中心線に塗る。
 *
 * 指定のしかた（shared/courses/*.json の "features"）:
 *   from    どのウェイポイントから始まるか
 *   offset  そこから何 m 進んだところから始まるか（省略すると 0）
 *   to      どのウェイポイントまでか  ┐ どちらかを書く
 *   length  始まりから何 m ぶんか     ┘
 * あとに書いたものが先に書いたものを上書きする。
 */
function applyFeatures(features: Feature[], courseLen: number, spacing: number, n: number,
                       wpDist: number[], kind: Int32Array, y: Float64Array): void {
  for (const f of features) {
    const kindId = KIND_BY_NAME[f.kind]
    if (kindId === undefined) throw new Error(`知らない仕掛けです: ${f.kind}`)
    const d0 = wpDist[f.from] + (f.offset ?? 0)
    let span: number
    if (f.length !== undefined) span = f.length
    else if (f.to !== undefined) span = mod(wpDist[f.to] - d0, courseLen)
    else if (kindId === KIND_RAMP) span = DEFAULT_RAMP_LENGTH
    else throw new Error(`${f.kind}: 'to' か 'length' が要ります`)
    if (span <= 0) continue
    const height = f.height ?? DEFAULT_RAMP_HEIGHT
    for (let k = 0; k < n; k++) {
      const rel = mod(k * spacing - d0, courseLen)
      if (rel > span) continue
      kind[k] = kindId
      // ジャンプ台は地面そのものを坂にする。坂の終わりは崖になっていて、
      // 速く走るほど（坂で得た上向きの速さぶん）遠くまで飛ぶ
      if (kindId === KIND_RAMP) y[k] += height * (rel / span)
    }
  }
}

export function build(data: CourseJson): Course {
  const wps = data.waypoints
  if (wps.length < 4) throw new Error('ウェイポイントは 4 個以上必要です')
  const defaultWidth = data.width ?? 16
  const { pts, wpIndex } = polyline(wps, defaultWidth)
  const { out, spacing, total, cum } = resample(pts)
  const n = out.length
  const x = Float64Array.from(out, (p) => p[0])
  const y = Float64Array.from(out, (p) => p[1])
  const z = Float64Array.from(out, (p) => p[2])
  const width = Float64Array.from(out, (p) => p[3])
  const bankExtra = Float64Array.from(out, (p) => p[4])

  const heading = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const a = mod(k + 1, n), b = mod(k - 1, n)
    heading[k] = Math.atan2(x[a] - x[b], z[a] - z[b])
  }
  // 曲がり具合から、コーナーの傾き（バンク）を自動でつける
  const bank = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const curv = wrapAngle(heading[mod(k + 1, n)] - heading[mod(k - 1, n)]) / (2 * spacing)
    // 右へ曲がるときは heading が減る（curv < 0）ので符号を反転し、
    // 「右コーナーでは右側（＝内側）が下がる」ようにする
    bank[k] = clamp(-curv * BANK_GAIN, -BANK_MAX, BANK_MAX) - Math.sign(curv) * Math.abs(bankExtra[k])
  }

  const kind = new Int32Array(n)
  applyFeatures(data.features ?? [], total, spacing, n, wpIndex.map((i) => cum[i]), kind, y)

  // 落ちたときに戻る場所: その点から後ろへたどって、最初に道がある点
  const safe = new Int32Array(n)
  let last = kind.indexOf(KIND_GAP) === -1 ? 0 : kind.findIndex((k) => k !== KIND_GAP)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      if (kind[k] !== KIND_GAP) last = k
      safe[k] = last
    }
  }

  return {
    id: data.id, name: data.name ?? data.id, theme: data.theme ?? 'meadow',
    description: data.description ?? '', laps: data.laps ?? 3,
    n, spacing, length: total, x, y, z, width, bank, heading, kind, safe,
  }
}

/** 今いる点の番号。前回の番号の近くだけを調べる（コースが近くで交差していても迷わない） */
export function nearest(c: Course, px: number, pz: number, prev: number,
                        back = 8, fwd = 20): number {
  let best = prev
  let bestD = Infinity
  for (let o = -back; o <= fwd; o++) {
    const i = mod(prev + o, c.n)
    const dx = px - c.x[i], dz = pz - c.z[i]
    const d = dx * dx + dz * dz
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

/** コース全体から一番近い点を探す（スタート時・コース復帰のときだけ使う） */
export function nearestGlobal(c: Course, px: number, pz: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < c.n; i++) {
    const dx = px - c.x[i], dz = pz - c.z[i]
    const d = dx * dx + dz * dz
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// --- コースの一覧（shared/courses/*.json をそのまま読む）------------------------

const COURSE_FILES = import.meta.glob<CourseJson>('../../../../../shared/courses/*.json', {
  eager: true, import: 'default',
})

/** ファイル名順のコース定義 */
export const COURSE_DEFS: CourseJson[] = Object.entries(COURSE_FILES)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([, v]) => v)

const cache = new Map<string, Course>()

export const courseIds = () => COURSE_DEFS.map((d) => d.id)

export function load(id: string): Course {
  const hit = cache.get(id)
  if (hit) return hit
  const def = COURSE_DEFS.find((d) => d.id === id)
  if (!def) throw new Error(`コース '${id}' がありません`)
  const c = build(def)
  cache.set(id, c)
  return c
}
