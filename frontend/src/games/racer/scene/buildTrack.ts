// コースの中心線から、道の 3D モデルを組み立てる。
//
// 中心線は engine/course.ts が 1m ごとの点に並べ直したもので、物理が使っているのと同じ配列。
// つまり「見えている道」と「当たり判定の道」は必ず一致する（ずれようがない）。
//
// 作るもの:
//   路面        路面の種類（加速パネル・砂・ジャンプ台）で色を変える
//   縁石        道の左右に赤白（テーマによる）の帯
//   ガードレール 縁石の外側に立てる帯。夜のコースでは光らせる
//   側面と橋脚   道に厚みをつけ、高いところでは地面まで柱を下ろす（高架に見せる）
//   スタート線   市松模様
//
// 道が途切れている区間（gap）には何も作らない。そこが「穴」になる。

import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import * as CO from '../engine/course'
import type { Theme } from './themes'

const SKIRT = 2.2 // 道の厚み（側面の高さ、m）
const KERB_WIDTH = 1.1
const KERB_STEP = 4 // 縁石の色が変わる間隔（m）
const CENTER_STEP = 3 // 中央線の白と空きの間隔（m）
const CENTER_HALF = 0.22 // 中央線の幅の半分（m）
const RAIL_HEIGHT = 0.9
const RAIL_THICK = 0.18
const PILLAR_EVERY = 16 // 橋脚を立てる間隔（m）
const PILLAR_MIN_HEIGHT = 5 // 地面からこれ以上高いところにだけ橋脚を立てる

/** 中心線の点 i の、中心から「運転者から見て右」へ o m ずれた位置（道の傾き＝バンクを反映する） */
export function edgePoint(c: CO.Course, i: number, o: number): [number, number, number] {
  const head = c.heading[i]
  const b = c.bank[i]
  const rx = -Math.cos(head), rz = Math.sin(head)
  const cos = Math.cos(b), sin = Math.sin(b)
  return [c.x[i] + rx * o * cos, c.y[i] - o * sin, c.z[i] + rz * o * cos]
}

/** 三角形を 2 枚ぶん（四角形 1 枚）書き込むための入れ物 */
class Strip {
  pos: number[] = []
  col: number[] = []
  private c = new THREE.Color()

  quad(a: number[], b: number[], d: number[], e: number[], color: number, shade = 1): void {
    this.c.setHex(color)
    const r = this.c.r * shade, g = this.c.g * shade, bl = this.c.b * shade
    for (const p of [a, b, d, a, d, e]) {
      this.pos.push(p[0], p[1], p[2])
      this.col.push(r, g, bl)
    }
  }

  /**
   * smooth を true にすると、同じ位置・同じ色の頂点をまとめてから法線を出す。
   *
   * まとめないと、四角形を割った三角形 1 枚ごとに法線が決まってしまう。道は幅 15m・奥行き 1m という
   * 細長い四角形なので、バンクがわずかにねじれるだけで 2 枚の向きが数十度ずれ、
   * 路面が凸凹しているように縞々に見えてしまう。まとめれば隣り合う面の傾きが平均されてなめらかになる。
   * 色が違うところ（加速パネルや砂の境目）は頂点がまとまらないので、色の境目はくっきり残る。
   */
  mesh(material: THREE.Material, smooth = false): THREE.Mesh {
    let geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    if (smooth) {
      const merged = mergeVertices(geo)
      geo.dispose()
      geo = merged
    }
    geo.computeVertexNormals()
    return new THREE.Mesh(geo, material)
  }
}

function surfaceColor(kind: number, t: Theme): number {
  if (kind === CO.KIND_BOOST) return t.railGlow ? 0x21f0ff : 0x3bd6ff
  if (kind === CO.KIND_DIRT) return t.ground
  if (kind === CO.KIND_RAMP) return t.kerbB
  return t.road
}

export interface TrackModel {
  group: THREE.Group
  dispose(): void
}

export function buildTrack(c: CO.Course, t: Theme): TrackModel {
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []

  const road = new Strip()
  const kerb = new Strip()
  const skirt = new Strip()
  const rail = new Strip()
  const paint = new Strip() // 中央線とスタート線（光の影響を受けない塗り）

  const half = (i: number) => c.width[i] / 2

  for (let i = 0; i < c.n; i++) {
    const j = (i + 1) % c.n
    // 道が途切れている区間には路面を作らない（ここが穴になる）
    if (c.kind[i] === CO.KIND_GAP || c.kind[j] === CO.KIND_GAP) continue

    const li = edgePoint(c, i, -half(i)), ri = edgePoint(c, i, half(i))
    const lj = edgePoint(c, j, -half(j)), rj = edgePoint(c, j, half(j))
    road.quad(li, ri, rj, lj, surfaceColor(c.kind[i], t))

    // 中央の白い破線。道の真ん中がどこか分かりやすくなり、速さも感じやすくなる
    if (Math.floor(i / CENTER_STEP) % 2 === 0 && c.kind[i] === CO.KIND_NORMAL) {
      const a = edgePoint(c, i, -CENTER_HALF), b = edgePoint(c, i, CENTER_HALF)
      const d = edgePoint(c, j, CENTER_HALF), e = edgePoint(c, j, -CENTER_HALF)
      for (const p of [a, b, d, e]) p[1] += 0.02
      paint.quad(a, b, d, e, t.kerbA)
    }

    // 縁石（左右）。一定の間隔で 2 色を切り替える
    const kc = Math.floor(i / KERB_STEP) % 2 === 0 ? t.kerbA : t.kerbB
    for (const side of [-1, 1]) {
      const oi = side * half(i), oj = side * half(j)
      const inner_i = edgePoint(c, i, oi), inner_j = edgePoint(c, j, oj)
      const outer_i = edgePoint(c, i, oi + side * KERB_WIDTH)
      const outer_j = edgePoint(c, j, oj + side * KERB_WIDTH)
      outer_i[1] += 0.06
      outer_j[1] += 0.06
      kerb.quad(inner_i, outer_i, outer_j, inner_j, kc)

      // ガードレール（縁石の外側に立てる帯）
      const base_i = [...outer_i] as number[], base_j = [...outer_j] as number[]
      const top_i = [base_i[0], base_i[1] + RAIL_HEIGHT, base_i[2]]
      const top_j = [base_j[0], base_j[1] + RAIL_HEIGHT, base_j[2]]
      const low_i = [base_i[0], base_i[1] + RAIL_HEIGHT - RAIL_THICK, base_i[2]]
      const low_j = [base_j[0], base_j[1] + RAIL_HEIGHT - RAIL_THICK, base_j[2]]
      rail.quad(low_i, top_i, top_j, low_j, t.rail)
      rail.quad(low_j, top_j, top_i, low_i, t.rail) // 裏からも見えるように

      // 道の側面（厚み）
      const down_i = [outer_i[0], outer_i[1] - SKIRT, outer_i[2]]
      const down_j = [outer_j[0], outer_j[1] - SKIRT, outer_j[2]]
      skirt.quad(outer_i, down_i, down_j, outer_j, t.road, 0.55)
      skirt.quad(outer_j, down_j, down_i, outer_i, t.road, 0.55)
    }
  }

  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide })
  const kerbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide })
  const railMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: t.railGlow ? 0.2 : 0.5, metalness: t.railGlow ? 0.1 : 0.7,
    emissive: t.railGlow ? new THREE.Color(t.rail) : new THREE.Color(0x000000),
    emissiveIntensity: t.railGlow ? 1.4 : 0,
    side: THREE.DoubleSide,
  })
  disposables.push(solid, kerbMat, railMat)

  const roadMesh = road.mesh(solid, true)
  roadMesh.receiveShadow = true
  group.add(roadMesh)
  group.add(kerb.mesh(kerbMat, true))
  group.add(rail.mesh(railMat))
  const skirtMesh = skirt.mesh(solid, true)
  group.add(skirtMesh)
  for (const m of [roadMesh, skirtMesh]) disposables.push(m.geometry)

  // --- 橋脚（高いところだけ）-------------------------------------------------
  const pillars: THREE.Matrix4[] = []
  const step = Math.max(1, Math.round(PILLAR_EVERY / c.spacing))
  for (let i = 0; i < c.n; i += step) {
    if (c.kind[i] === CO.KIND_GAP) continue
    const h = c.y[i] - SKIRT
    if (h < PILLAR_MIN_HEIGHT) continue
    const m = new THREE.Matrix4()
    m.compose(
      new THREE.Vector3(c.x[i], h / 2, c.z[i]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, c.heading[i], 0)),
      new THREE.Vector3(c.width[i] * 0.35, h, c.width[i] * 0.35),
    )
    pillars.push(m)
  }
  if (pillars.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({ color: t.road, roughness: 0.9 })
    const inst = new THREE.InstancedMesh(geo, mat, pillars.length)
    pillars.forEach((m, k) => inst.setMatrixAt(k, m))
    inst.castShadow = true
    group.add(inst)
    disposables.push(geo, mat)
  }

  // --- スタート / ゴール線（市松模様）------------------------------------------
  const SQUARES = 10
  for (let k = 0; k < SQUARES; k++) {
    const o0 = -half(0) + (c.width[0] * k) / SQUARES
    const o1 = -half(0) + (c.width[0] * (k + 1)) / SQUARES
    for (const [i, j] of [[c.n - 2, c.n - 1], [c.n - 1, 0]] as [number, number][]) {
      const color = (k + (j === 0 ? 1 : 0)) % 2 === 0 ? 0xf5f5f5 : 0x14141a
      const a = edgePoint(c, i, o0), b = edgePoint(c, i, o1)
      const d = edgePoint(c, j, o1), e = edgePoint(c, j, o0)
      for (const p of [a, b, d, e]) p[1] += 0.03
      paint.quad(a, b, d, e, color)
    }
  }
  const paintMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
  group.add(paint.mesh(paintMat))
  disposables.push(paintMat)

  return {
    group,
    dispose() {
      group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
      for (const d of disposables) d.dispose()
    },
  }
}
