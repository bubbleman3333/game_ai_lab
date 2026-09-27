// 街の 3D モデルを組み立てる。形は sim/cityMap.ts の地図から全部自動で作る。
//
// 描画命令を減らすため、同じ見た目のものはまとめる:
//   建物の壁・屋根・地面・道路標示 … GeoBuilder で 1 つの形に詰める（種類ごとに 1 回の描画）
//   街灯・木・信号                  … InstancedMesh（同じ形を位置だけ変えて何千個も描く）
//
// 夜になると窓・店・街灯が光る。setNight() で明るさを変える（CityScene が毎フレーム呼ぶ）。

import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  BLOCK_HALF, CROSSWALK_DIST, CURB_HEIGHT, CityMap, DIRS, HALF_CITY, LOT_HALF, NODES, PITCH, ROAD_HALF,
  SEAWALL, STOP_DIST, leftOf, nodeX, type Style,
} from '../sim/cityMap'
import { makeRng, range } from '../sim/rng'
import { GeoBuilder } from './geoBuilder'
import * as TX from './textures'
import type { CityTheme } from './themes'
import { addWallDetail, repeated, type Photos } from './photoTextures'

const STYLES: Style[] = ['glass', 'office', 'concrete', 'brick', 'warehouse', 'house']
const SHOP_H = TX.SHOP_HEIGHT

export interface CityModel {
  group: THREE.Group
  /** 夜の度合い（0 = 昼、1 = 夜）に合わせて光るものの明るさを変える */
  setNight(n: number): void
  /** 写真のテクスチャが読み込めたら、道路・歩道・壁などに差し替える */
  applyPhotos(photos: Photos): void
  /** 信号の色と、倒れた街灯を反映する */
  update(time: number, broken: Uint8Array, brokenYaw: Float32Array): void
  water: THREE.Mesh
  dispose(): void
}

export function buildCity(map: CityMap, theme: CityTheme): CityModel {
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x }
  const rng = makeRng(4242)

  // --- 地面 ------------------------------------------------------------------------
  const asphalt = keep(TX.asphalt())
  asphalt.repeat.set(1, 1)
  // 雨の街は路面が濡れてつやが出る（空や明かりが映る）
  const roadMat = keep(new THREE.MeshStandardMaterial({
    map: asphalt, roughness: 0.93 - theme.wet * 0.6, metalness: theme.wet * 0.15, color: theme.snow ? 0xc8ccd2 : 0xffffff,
  }))
  const roadGeo = new GeoBuilder()
  const E = SEAWALL
  roadGeo.top(-E, -E, E, E, 0, 12)
  const road = new THREE.Mesh(keep(roadGeo.build()), roadMat)
  road.receiveShadow = true
  group.add(road)

  const paveTex = keep(TX.paving())
  const paveMat = keep(new THREE.MeshStandardMaterial({ map: paveTex, roughness: 0.85 - theme.wet * 0.4, color: theme.snow ? 0xeef2f6 : 0xffffff }))
  const grassTex = keep(TX.grass())
  const grassMat = keep(new THREE.MeshStandardMaterial({ map: theme.snow ? null : grassTex, roughness: 1, color: theme.snow ? 0xf2f5f8 : 0xffffff }))
  const concreteMat = keep(new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.9 }))
  const pave = new GeoBuilder()
  const grass = new GeoBuilder()
  const concrete = new GeoBuilder()
  for (const b of map.blocks) {
    // 区画全体を歩道の高さに上げる（側面が縁石になる）
    pave.walls(b.cx - BLOCK_HALF, b.cz - BLOCK_HALF, b.cx + BLOCK_HALF, b.cz + BLOCK_HALF, 0, CURB_HEIGHT, 4, 4)
    if (b.district === 'park' || b.district === 'residential') {
      // 歩道の輪だけ敷石、中は芝生
      const o = BLOCK_HALF, i = LOT_HALF
      pave.top(b.cx - o, b.cz - o, b.cx + o, b.cz - i, CURB_HEIGHT, 4)
      pave.top(b.cx - o, b.cz + i, b.cx + o, b.cz + o, CURB_HEIGHT, 4)
      pave.top(b.cx - o, b.cz - i, b.cx - i, b.cz + i, CURB_HEIGHT, 4)
      pave.top(b.cx + i, b.cz - i, b.cx + o, b.cz + i, CURB_HEIGHT, 4)
      grass.top(b.cx - i, b.cz - i, b.cx + i, b.cz + i, CURB_HEIGHT, 8)
      // 芝生のふちの縁石
      concrete.walls(b.cx - i, b.cz - i, b.cx + i, b.cz + i, CURB_HEIGHT, CURB_HEIGHT + 0.12, 2, 2)
    } else if (b.district === 'industrial') {
      pave.top(b.cx - BLOCK_HALF, b.cz - BLOCK_HALF, b.cx + BLOCK_HALF, b.cz + BLOCK_HALF, CURB_HEIGHT, 4)
    } else {
      pave.top(b.cx - BLOCK_HALF, b.cz - BLOCK_HALF, b.cx + BLOCK_HALF, b.cz + BLOCK_HALF, CURB_HEIGHT, 4)
    }
  }
  for (const p of map.paths) pave.top(p.x0, p.z0, p.x1, p.z1, CURB_HEIGHT + 0.02, 4)
  // 外周の遊歩道（外周道路の外側）
  const inner = HALF_CITY + ROAD_HALF
  for (const [x0, z0, x1, z1] of [[-E, -E, E, -inner], [-E, inner, E, E], [-E, -inner, -inner, inner], [inner, -inner, E, inner]]) {
    pave.top(x0, z0, x1, z1, CURB_HEIGHT, 4)
  }
  pave.walls(-inner, -inner, inner, inner, 0, CURB_HEIGHT, 4, 4) // 内向きの縁石（向きは外向きだが細いので問題ない）
  // 護岸: 腰の高さの壁と、海へ落ちる崖
  concrete.walls(-E, -E, E, E, -4, CURB_HEIGHT, 3, 3)
  concrete.box(-E - 0.4, CURB_HEIGHT, -E - 0.4, E + 0.4, 1.0, -E + 0.1, 2)
  concrete.box(-E - 0.4, CURB_HEIGHT, E - 0.1, E + 0.4, 1.0, E + 0.4, 2)
  concrete.box(-E - 0.4, CURB_HEIGHT, -E, -E + 0.1, 1.0, E, 2)
  concrete.box(E - 0.1, CURB_HEIGHT, -E, E + 0.4, 1.0, E, 2)
  for (const [g, m] of [[pave, paveMat], [grass, grassMat], [concrete, concreteMat]] as const) {
    const mesh = new THREE.Mesh(keep(g.build()), m)
    mesh.receiveShadow = true
    group.add(mesh)
  }

  // --- 海 ------------------------------------------------------------------------------
  const waterNormal = keep(TX.waterNormals())
  waterNormal.repeat.set(60, 60)
  const waterMat = keep(new THREE.MeshStandardMaterial({
    color: 0x1d3a4a, roughness: 0.08, metalness: 0.2, normalMap: waterNormal, normalScale: new THREE.Vector2(0.35, 0.35),
  }))
  const water = new THREE.Mesh(keep(new THREE.PlaneGeometry(6000, 6000)), waterMat)
  water.rotation.x = -Math.PI / 2
  water.position.y = -1.6
  group.add(water)

  // 遠くの山（霧にかすむ地平線）
  const hillMat = keep(new THREE.MeshStandardMaterial({ color: 0x3c4a44, roughness: 1, flatShading: true }))
  const hillGeo = keep(new THREE.ConeGeometry(1, 1, 14, 2))
  const hills = new THREE.InstancedMesh(hillGeo, hillMat, 28)
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s3 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2 + range(rng, -0.08, 0.08)
    const r = range(rng, 2100, 2700)
    const h = range(rng, 90, 260)
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6)
    m4.compose(p3.set(Math.sin(a) * r, -2, Math.cos(a) * r), q, s3.set(range(rng, 500, 900), h, range(rng, 500, 900)))
    hills.setMatrixAt(k, m4)
  }
  group.add(hills)

  // --- 道路標示 -----------------------------------------------------------------------
  const white = new GeoBuilder()
  const orange = new GeoBuilder()
  const Y = 0.012
  const strip = (g: GeoBuilder, cx: number, cz: number, len: number, wid: number, alongX: boolean) => {
    const hx = alongX ? len / 2 : wid / 2, hz = alongX ? wid / 2 : len / 2
    g.top(cx - hx, cz - hz, cx + hx, cz + hz, Y, 1)
  }
  for (let a = 0; a < NODES; a++) {
    for (let k = 0; k < NODES - 1; k++) {
      // x 方向の道（z = nodeX(a)）と z 方向の道（x = nodeX(a)）の、交差点 k と k+1 の間
      const s0 = nodeX(k), s1 = nodeX(k + 1)
      for (const alongX of [true, false]) {
        const c = nodeX(a)
        const mid = (s0 + s1) / 2
        const place = (off: number, len: number, wid: number, g: GeoBuilder, at = mid) =>
          alongX ? strip(g, at, c + off, len, wid, true) : strip(g, c + off, at, len, wid, false)
        const lineLen = PITCH - 2 * STOP_DIST
        // 中央線（オレンジ = はみ出し禁止）
        place(0.12, lineLen, 0.13, orange)
        place(-0.12, lineLen, 0.13, orange)
        // 車線の境目（白い破線）
        for (let t = s0 + STOP_DIST + 2; t < s1 - STOP_DIST - 2; t += 10) {
          place(3.75, 5, 0.13, white, t + 2.5)
          place(-3.75, 5, 0.13, white, t + 2.5)
        }
        // 外側線
        place(7.05, PITCH - 2 * ROAD_HALF, 0.15, white)
        place(-7.05, PITCH - 2 * ROAD_HALF, 0.15, white)
      }
    }
  }
  // 交差点ごとの停止線と横断歩道
  for (let j = 0; j < NODES; j++) for (let i = 0; i < NODES; i++) {
    for (let d = 0; d < 4; d++) {
      const [dx, dz] = DIRS[d]
      if (i + dx < 0 || j + dz < 0 || i + dx >= NODES || j + dz >= NODES) continue
      const cx = nodeX(i), cz = nodeX(j)
      const alongX = dx !== 0
      // 横断歩道: 道に沿った縞を、道幅いっぱいに並べる
      const ax = cx + dx * CROSSWALK_DIST, az = cz + dz * CROSSWALK_DIST
      for (let w = -6.3; w <= 6.3; w += 0.9) {
        if (alongX) strip(white, ax, az + w, 3.6, 0.45, true)
        else strip(white, ax + w, az, 3.6, 0.45, false)
      }
      // 停止線: この道から交差点へ向かう車（向き −d）の車線側（その左）
      const [lx, lz] = leftOf(-dx, -dz)
      const sx = cx + dx * STOP_DIST, sz = cz + dz * STOP_DIST
      const wx = sx + lx * 3.6, wz = sz + lz * 3.6
      if (alongX) strip(white, wx, wz, 0.45, 7, true)
      else strip(white, wx, wz, 0.45, 7, false)
    }
  }
  const markMat = (color: number) => keep(new THREE.MeshStandardMaterial({
    color, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }))
  for (const [g, c] of [[white, 0xe8e8e2], [orange, 0xe39a2d]] as const) {
    const mesh = new THREE.Mesh(keep(g.build()), markMat(c))
    mesh.receiveShadow = true
    group.add(mesh)
  }

  // --- 建物 ----------------------------------------------------------------------------
  const facades = Object.fromEntries(STYLES.map((s) => [s, TX.facade(s)])) as Record<Style, TX.FacadeTextures>
  // 店構えは 4 種類（同じ並びが続かないように、建物ごとに選ぶ）
  const SHOP_THEMES: TX.ShopTheme[] = ['downtown', 'nightlife', 'local']
  const shops = SHOP_THEMES.flatMap((th) => [0, 1, 2].map((k) => TX.shopfront(k, th)))
  const ads = TX.billboardAtlas()
  const signs = TX.signAtlas()
  const vend = TX.vendingFront()
  for (const f of [...Object.values(facades), ...shops, signs, vend, ads]) { keep(f.map); keep(f.rough); keep(f.emissive) }
  /** 壁から道路側へ突き出た縦長の看板（1 棟に 1〜3 枚） */
  const addSigns = (B: { x0: number; z0: number; x1: number; z1: number; h: number }, r: () => number, base: number) => {
    if (B.h < 10) return
    const faces: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const n = 1 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      const [nx, nz] = faces[Math.floor(r() * 4)]
      const along = r()
      const px = nx === 1 ? B.x1 : nx === -1 ? B.x0 : B.x0 + (B.x1 - B.x0) * (0.15 + along * 0.7)
      const pz = nz === 1 ? B.z1 : nz === -1 ? B.z0 : B.z0 + (B.z1 - B.z0) * (0.15 + along * 0.7)
      const y0 = base + SHOP_H + 0.6 + r() * 2, y1 = y0 + 3.2 + r() * 2
      const cell = Math.floor(r() * 16)
      const u0 = (cell % 4) / 4, u1 = u0 + 0.25
      const v1 = 1 - Math.floor(cell / 4) / 4, v0 = v1 - 0.25
      const out = 1.1
      const ax = px + nx * out, az = pz + nz * out
      // 表と裏（どちらから見ても読める）。t は看板の面の向き
      const tx = nz, tz = -nx
      signB.quad([ax, y0, az], [px, y0, pz], [px, y1, pz], [ax, y1, az], [tx, 0, tz], [u0, v0, u1, v0, u1, v1, u0, v1])
      signB.quad([px, y0, pz], [ax, y0, az], [ax, y1, az], [px, y1, pz], [-tx, 0, -tz], [u0, v0, u1, v0, u1, v1, u0, v1])
    }
  }

  /** 店先の自販機 */
  const addVending = (B: { x0: number; z0: number; x1: number; z1: number }, r: () => number, base: number) => {
    const faces: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const [nx, nz] = faces[Math.floor(r() * 4)]
    const t = 0.2 + r() * 0.6
    const cx = nx === 1 ? B.x1 + 0.45 : nx === -1 ? B.x0 - 0.45 : B.x0 + (B.x1 - B.x0) * t
    const cz = nz === 1 ? B.z1 + 0.45 : nz === -1 ? B.z0 - 0.45 : B.z0 + (B.z1 - B.z0) * t
    const hw = 0.5, hd = 0.4, h = 1.85
    const x0 = cx - (nx ? hd : hw), x1 = cx + (nx ? hd : hw), z0 = cz - (nz ? hd : hw), z1 = cz + (nz ? hd : hw)
    // 側面と天板は本体の色（絵の端の部分）、正面だけ見本の並んだ絵
    vendB.walls(x0, z0, x1, z1, base, base + h, 1000, 1000, 0.02, 0.95)
    vendB.top(x0, z0, x1, z1, base + h, 1000)
    const fx = cx + nx * (hd + 0.005), fz = cz + nz * (hd + 0.005)
    const tx = nz, tz = -nx // 正面の横方向（右から左）
    vendB.quad([fx - tx * hw, base, fz - tz * hw], [fx + tx * hw, base, fz + tz * hw], [fx + tx * hw, base + h, fz + tz * hw],
               [fx - tx * hw, base + h, fz - tz * hw], [nx, 0, nz], [0, 0, 1, 0, 1, 1, 0, 1])
  }

  const wallBuilders = Object.fromEntries(STYLES.map((s) => [s, new GeoBuilder()])) as Record<Style, GeoBuilder>
  const shopBs = shops.map(() => new GeoBuilder())
  const signB = new GeoBuilder()
  const vendB = new GeoBuilder()
  const adB = new GeoBuilder()
  const adFrameB = new GeoBuilder()
  const roofB = new GeoBuilder()
  const tileB = new GeoBuilder()
  const ledgeB = new GeoBuilder()
  for (const B of map.buildings) {
    const spec = TX.FACADE_SPECS[B.style]
    const brng = makeRng(B.seed)
    const u0 = Math.floor(brng() * 8) / 8
    const v0 = Math.floor(brng() * 8) / 8
    const su = spec.bay * 8, sv = spec.floor * 8
    const base = CURB_HEIGHT
    const y0 = base + (B.shop ? SHOP_H : 0)
    const top = base + B.h
    wallBuilders[B.style].walls(B.x0, B.z0, B.x1, B.z1, y0, top, su, sv, u0, v0 - y0 / sv)
    if (B.shop) {
      // 地区で店の種類を選ぶ（繁華街は高級店、中層の街は飲み屋街、住宅街は商店）
      const dist = map.blockAt((B.x0 + B.x1) / 2, (B.z0 + B.z1) / 2)?.district
      const th = dist === 'downtown' ? 0 : dist === 'residential' ? 2 : 1
      shopBs[th * 3 + Math.floor(brng() * 3)].walls(B.x0, B.z0, B.x1, B.z1, base, y0, TX.SHOP_WIDTH, SHOP_H,
                                                       Math.floor(brng() * 8) / 8, -base / SHOP_H)
      addSigns(B, brng, base)
      if (brng() < 0.45) addVending(B, brng, base)
      // 1 階と 2 階の境目の庇
      ledgeB.box(B.x0 - 0.5, y0 - 0.25, B.z0 - 0.5, B.x1 + 0.5, y0 + 0.05, B.z1 + 0.5, 2)
    }
    if (B.roof === 'gable') {
      // 切妻屋根: 長い辺に沿って棟を通す
      const w = B.x1 - B.x0, d = B.z1 - B.z0
      const rh = Math.min(w, d) * 0.38
      const o = 0.45
      if (w >= d) {
        const zm = (B.z0 + B.z1) / 2
        tileB.quad([B.x1 + o, top - 0.2, B.z0 - o], [B.x0 - o, top - 0.2, B.z0 - o], [B.x0 - o, top + rh, zm], [B.x1 + o, top + rh, zm],
                   [0, 0.8, -0.6], [0, 0, w / 3, 0, w / 3, d / 4, 0, d / 4])
        tileB.quad([B.x0 - o, top - 0.2, B.z1 + o], [B.x1 + o, top - 0.2, B.z1 + o], [B.x1 + o, top + rh, zm], [B.x0 - o, top + rh, zm],
                   [0, 0.8, 0.6], [0, 0, w / 3, 0, w / 3, d / 4, 0, d / 4])
        wallBuilders.house.tri([B.x1, top, B.z0], [B.x1, top, B.z1], [B.x1, top + rh, zm], [1, 0, 0], [0, 0.2, 0.3, 0.2, 0.15, 0.3])
        wallBuilders.house.tri([B.x0, top, B.z1], [B.x0, top, B.z0], [B.x0, top + rh, zm], [-1, 0, 0], [0, 0.2, 0.3, 0.2, 0.15, 0.3])
      } else {
        const xm = (B.x0 + B.x1) / 2
        tileB.quad([B.x0 - o, top - 0.2, B.z0 - o], [B.x0 - o, top - 0.2, B.z1 + o], [xm, top + rh, B.z1 + o], [xm, top + rh, B.z0 - o],
                   [-0.6, 0.8, 0], [0, 0, d / 3, 0, d / 3, w / 4, 0, w / 4])
        tileB.quad([B.x1 + o, top - 0.2, B.z1 + o], [B.x1 + o, top - 0.2, B.z0 - o], [xm, top + rh, B.z0 - o], [xm, top + rh, B.z1 + o],
                   [0.6, 0.8, 0], [0, 0, d / 3, 0, d / 3, w / 4, 0, w / 4])
        wallBuilders.house.tri([B.x0, top, B.z0], [B.x1, top, B.z0], [xm, top + rh, B.z0], [0, 0, -1], [0, 0.2, 0.3, 0.2, 0.15, 0.3])
        wallBuilders.house.tri([B.x1, top, B.z1], [B.x0, top, B.z1], [xm, top + rh, B.z1], [0, 0, 1], [0, 0.2, 0.3, 0.2, 0.15, 0.3])
      }
      continue
    }
    // 平らな屋根と、ふちの立ち上がり（パラペット）
    roofB.top(B.x0, B.z0, B.x1, B.z1, top, 6)
    const t = 0.35
    roofB.box(B.x0, top, B.z0, B.x1, top + 1, B.z0 + t, 2)
    roofB.box(B.x0, top, B.z1 - t, B.x1, top + 1, B.z1, 2)
    roofB.box(B.x0, top, B.z0, B.x0 + t, top + 1, B.z1, 2)
    roofB.box(B.x1 - t, top, B.z0, B.x1, top + 1, B.z1, 2)
    // 屋上の設備（室外機・塔屋・給水タンク）
    const w = B.x1 - B.x0, d = B.z1 - B.z0
    const n = B.h > 30 ? 3 : B.style === 'warehouse' ? 1 : 2
    for (let k = 0; k < n; k++) {
      const bw = range(brng, 2, Math.min(7, w * 0.35)), bd = range(brng, 2, Math.min(7, d * 0.35))
      const x = range(brng, B.x0 + 1.5, B.x1 - 1.5 - bw), z = range(brng, B.z0 + 1.5, B.z1 - 1.5 - bd)
      roofB.box(x, top, z, x + bw, top + range(brng, 1.2, B.h > 30 ? 4.5 : 2.2), z + bd, 2)
    }
    // 屋上の広告看板（中くらいの高さのビル）
    if (B.h > 14 && B.h < 75 && brng() < 0.4) {
      const faces: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      const [nx, nz] = faces[Math.floor(brng() * 4)]
      const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2
      const span = nx ? B.z1 - B.z0 : B.x1 - B.x0
      const hw = Math.min(8, span * 0.4), hh = hw * 0.42
      const px = nx === 1 ? B.x1 - 1.5 : nx === -1 ? B.x0 + 1.5 : cx
      const pz = nz === 1 ? B.z1 - 1.5 : nz === -1 ? B.z0 + 1.5 : cz
      const tx = nz, tz = -nx // 看板の横方向
      const yb = top + 2.5, yt = yb + hh * 2
      const cell = Math.floor(brng() * 8)
      const u0 = (cell % 2) / 2, u1 = u0 + 0.5
      const v1 = 1 - Math.floor(cell / 2) / 4, v0 = v1 - 0.25
      adB.quad([px - tx * hw, yb, pz - tz * hw], [px + tx * hw, yb, pz + tz * hw], [px + tx * hw, yt, pz + tz * hw],
               [px - tx * hw, yt, pz - tz * hw], [nx, 0, nz], [u0, v0, u1, v0, u1, v1, u0, v1])
      // 骨組み（裏側の柱）
      for (const s of [-0.8, 0, 0.8]) {
        const fx = px + tx * hw * s - nx * 0.6, fz = pz + tz * hw * s - nz * 0.6
        adFrameB.box(fx - 0.15, top, fz - 0.15, fx + 0.15, yt, fz + 0.15, 1)
      }
    }
    // 高いビルは屋上にアンテナ
    if (B.h > 80) {
      const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2
      roofB.box(cx - 0.3, top, cz - 0.3, cx + 0.3, top + range(brng, 10, 22), cz + 0.3, 1)
    }
  }
  const wallMats: THREE.MeshStandardMaterial[] = []
  const wallByStyle = new Map<Style, THREE.MeshStandardMaterial>()
  for (const s of STYLES) {
    const g = wallBuilders[s]
    if (g.empty) continue
    const f = facades[s]
    const mat = keep(new THREE.MeshStandardMaterial({
      map: f.map, roughnessMap: f.rough, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0,
      roughness: s === 'glass' ? 0.9 : 1, metalness: s === 'glass' ? 0.3 : s === 'warehouse' ? 0.3 : 0.05,
      // 空の映り込みは控えめに（斜めから見るとガラスが真っ白に光ってしまうので）
      envMapIntensity: 0.4,
    }))
    wallMats.push(mat)
    wallByStyle.set(s, mat)
    const mesh = new THREE.Mesh(keep(g.build()), mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }
  const shopMats = shops.map((shop, k) => {
    const mat = keep(new THREE.MeshStandardMaterial({
      map: shop.map, roughnessMap: shop.rough, emissiveMap: shop.emissive, emissive: 0xffffff, emissiveIntensity: 0.15,
      roughness: 1, metalness: 0.1,
    }))
    const mesh = new THREE.Mesh(keep(shopBs[k].build()), mat)
    mesh.receiveShadow = true
    group.add(mesh)
    return mat
  })
  const glowMat = (t: TX.FacadeTextures) => keep(new THREE.MeshStandardMaterial({
    map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.4, side: THREE.DoubleSide,
  }))
  const signMat = glowMat(signs)
  const adMat = glowMat(ads)
  if (!adB.empty) {
    const adMesh = new THREE.Mesh(keep(adB.build()), adMat)
    group.add(adMesh)
    const frame = new THREE.Mesh(keep(adFrameB.build()), keep(new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.6, roughness: 0.5 })))
    frame.castShadow = true
    group.add(frame)
  }
  const vendMat = glowMat(vend)
  for (const [g, m] of [[signB, signMat], [vendB, vendMat]] as const) {
    if (g.empty) continue
    const mesh = new THREE.Mesh(keep(g.build()), m)
    mesh.castShadow = true
    group.add(mesh)
  }
  const gravel = keep(TX.gravelRoof())
  const roofMat = keep(new THREE.MeshStandardMaterial({ map: gravel, roughness: 0.95, color: theme.snow ? 0xf4f7fa : 0xffffff }))
  const roofMesh = new THREE.Mesh(keep(roofB.build()), roofMat)
  roofMesh.castShadow = true
  roofMesh.receiveShadow = true
  group.add(roofMesh)
  const tiles = keep(TX.roofTiles())
  const tileMat = keep(new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.7, side: THREE.DoubleSide, color: theme.snow ? 0xe8edf2 : 0xffffff }))
  const tileMesh = new THREE.Mesh(keep(tileB.build()), tileMat)
  tileMesh.castShadow = true
  tileMesh.receiveShadow = true
  group.add(tileMesh)
  const ledgeMesh = new THREE.Mesh(keep(ledgeB.build()), concreteMat)
  ledgeMesh.castShadow = true
  group.add(ledgeMesh)

  // --- 街灯 -----------------------------------------------------------------------------
  const lamps = map.props.map((p, i) => [p, i] as const).filter(([p]) => p.kind === 'lamp')
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.7, roughness: 0.45 }))
  const lampPole = new GeoBuilder()
  lampPole.box(-0.09, 0, -0.09, 0.09, 8, 0.09)
  lampPole.box(-0.05, 7.7, 0, 0.05, 7.82, 2.4) // 道路へ伸びる腕（ローカル +z）
  lampPole.box(-0.2, 0, -0.2, 0.2, 0.6, 0.2)
  const lampHeadGeo = keep(new THREE.BoxGeometry(0.34, 0.12, 0.7))
  lampHeadGeo.translate(0, 7.66, 2.3)
  const lampHeadMat = keep(new THREE.MeshStandardMaterial({ color: 0x222, emissive: 0xffd9a0, emissiveIntensity: 0 }))
  const poleMesh = new THREE.InstancedMesh(keep(lampPole.build()), metal, lamps.length)
  const headMesh = new THREE.InstancedMesh(lampHeadGeo, lampHeadMat, lamps.length)
  poleMesh.castShadow = true
  // 夜に地面を照らす光の輪（本物のライトを 1700 個置くと重すぎるので、光った地面の絵を敷く）
  const poolTex = keep(TX.softDot(128, 1.6))
  const poolMat = keep(new THREE.MeshBasicMaterial({
    map: poolTex, color: 0xffc98a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }))
  const poolGeo = keep(new THREE.PlaneGeometry(1, 1))
  poolGeo.rotateX(-Math.PI / 2)
  const poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, lamps.length)
  poolMesh.renderOrder = 1
  const lampMatrix = (k: number, fallen: boolean, fallYaw: number) => {
    const [p] = lamps[k]
    const y = CURB_HEIGHT
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw)
    if (fallen) {
      // 根元を軸に、倒れた向きへ横倒しにする
      const axis = new THREE.Vector3(Math.cos(fallYaw), 0, -Math.sin(fallYaw))
      const qf = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2 * 0.96)
      qy.premultiply(qf)
    }
    m4.compose(p3.set(p.x, y, p.z), qy, s3.set(1, 1, 1))
    return m4
  }
  lamps.forEach(([p], k) => {
    const m = lampMatrix(k, false, 0)
    poleMesh.setMatrixAt(k, m)
    headMesh.setMatrixAt(k, m)
    const ax = p.x + Math.sin(p.yaw) * 2.3, az = p.z + Math.cos(p.yaw) * 2.3
    m4.compose(p3.set(ax, 0.03, az), q.identity(), s3.set(15, 1, 15))
    poolMesh.setMatrixAt(k, m4)
  })
  group.add(poleMesh, headMesh, poolMesh)

  // --- 木 --------------------------------------------------------------------------------
  const trees = map.props.filter((p) => p.kind === 'tree')
  const trunkGeo = keep(new THREE.CylinderGeometry(0.14, 0.22, 3.2, 7))
  trunkGeo.translate(0, 1.6, 0)
  const trunkMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.95 }))
  // 葉: いくつかの多面体をずらして重ね、頂点を少し揺らしてこんもりさせる
  const leafParts: THREE.BufferGeometry[] = []
  for (const [x, y, z, r] of [[0, 4.2, 0, 1.9], [0.8, 3.6, 0.4, 1.4], [-0.7, 3.8, -0.5, 1.5], [0.1, 5.1, -0.2, 1.3]]) {
    const g = new THREE.IcosahedronGeometry(r, 3)
    const pos = g.attributes.position
    for (let k = 0; k < pos.count; k++) {
      // 葉のかたまりのでこぼこ（細かい凹凸と大きなうねりを重ねる）
      const n = 1 + (Math.sin(pos.getX(k) * 5.1 + pos.getY(k) * 3.7) * 0.5 + 0.5) * 0.14 + Math.sin(pos.getX(k) * 17 + pos.getZ(k) * 13) * 0.05
      pos.setXYZ(k, pos.getX(k) * n + x, pos.getY(k) * n + y, pos.getZ(k) * n + z)
    }
    leafParts.push(g.toNonIndexed())
    g.dispose()
  }
  // つなぎ直して、なめらかな陰影にする（つながないと面ごとに角ばって見える）
  const leafGeo = keep(mergeVertices(mergeSimple(leafParts), 1e-4))
  leafGeo.computeVertexNormals()
  const leafMat = keep(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }))
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length)
  const leafMesh = new THREE.InstancedMesh(leafGeo, leafMat, trees.length)
  trunkMesh.castShadow = leafMesh.castShadow = true
  leafMesh.receiveShadow = true
  const leafColor = new THREE.Color()
  trees.forEach((t, k) => {
    const y = CURB_HEIGHT
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw)
    m4.compose(p3.set(t.x, y, t.z), q, s3.set(t.scale, t.scale * range(rng, 0.9, 1.15), t.scale))
    trunkMesh.setMatrixAt(k, m4)
    leafMesh.setMatrixAt(k, m4)
    leafColor.setHSL(range(rng, 0.22, 0.32), range(rng, 0.35, 0.55), range(rng, 0.2, 0.3))
    leafMesh.setColorAt(k, leafColor)
  })
  group.add(trunkMesh, leafMesh)

  // --- 信号 ------------------------------------------------------------------------------
  const signals = map.props.filter((p) => p.kind === 'signal')
  const sigPole = new GeoBuilder()
  sigPole.box(-0.12, 0, -0.12, 0.12, 5.6, 0.12)
  sigPole.box(0, 5.3, -0.06, 4.2, 5.42, 0.06) // 車道の上へ伸びる腕（ローカル +x）
  const sigPoleMesh = new THREE.InstancedMesh(keep(sigPole.build()), metal, signals.length)
  sigPoleMesh.castShadow = true
  const housingGeo = keep(new THREE.BoxGeometry(1.35, 0.46, 0.3))
  housingGeo.translate(3.5, 5.05, 0)
  const housingMat = keep(new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.3 }))
  const housingMesh = new THREE.InstancedMesh(housingGeo, housingMat, signals.length)
  housingMesh.castShadow = true
  // 灯: 左から 青・黄・赤（日本の横型信号）
  const lampGeo = keep(new THREE.CircleGeometry(0.16, 16))
  const lampMeshes = [0, 1, 2].map((c) => {
    const g = keep(lampGeo.clone())
    g.translate(3.5 - 0.42 + c * 0.42, 5.05, 0.16)
    const mesh = new THREE.InstancedMesh(g, keep(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })), signals.length)
    return mesh
  })
  signals.forEach((s, k) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw)
    m4.compose(p3.set(s.x, CURB_HEIGHT, s.z), q, s3.set(1, 1, 1))
    sigPoleMesh.setMatrixAt(k, m4)
    housingMesh.setMatrixAt(k, m4)
    for (const lm of lampMeshes) lm.setMatrixAt(k, m4)
  })
  group.add(sigPoleMesh, housingMesh, ...lampMeshes)
  const ON = [new THREE.Color(0.1, 1.6, 1.1), new THREE.Color(2.2, 1.3, 0.1), new THREE.Color(2.4, 0.15, 0.1)]
  const OFF = [new THREE.Color(0.02, 0.07, 0.06), new THREE.Color(0.09, 0.06, 0.01), new THREE.Color(0.09, 0.02, 0.02)]

  let night = 0
  const lampBroken = new Uint8Array(lamps.length)

  return {
    group,
    water,
    applyPhotos(photos: Photos) {
      // 床: 写真の色・凹凸・つや。UV は「世界の座標 ÷ 何 m」なので、repeat で 1 枚が何 m になるかを決める
      const floor = (mat: THREE.MeshStandardMaterial, name: keyof Photos, r: number, normal = 1) => {
        const ph = photos[name]
        mat.map = repeated(ph.diff, r)
        mat.normalMap = repeated(ph.nor, r)
        mat.normalScale = new THREE.Vector2(normal, normal)
        mat.roughnessMap = repeated(ph.rough, r)
        mat.needsUpdate = true
        for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) keep(t)
      }
      floor(roadMat, 'asphalt', 4, 1.2) // 道路の UV は 12m ごと → 1 枚 3m
      roadMat.roughness = 1 - theme.wet * 0.55
      floor(paveMat, 'pavers', 2) // 歩道の UV は 4m ごと → 1 枚 2m
      if (!theme.snow) floor(grassMat, 'grass', 3)
      floor(concreteMat, 'concrete', 1)
      concreteMat.color.set(0xffffff)
      floor(roofMat, 'gravel', 2)
      floor(tileMat, 'roof', 1.5)
      // 壁: 窓の絵はそのまま、壁の部分だけ写真の質感に（ガラス張りのビルはそのまま）
      const walls: [Style, keyof Photos, number][] = [
        ['office', 'tiles', 2.2], ['concrete', 'concrete', 3], ['brick', 'brick', 2], ['warehouse', 'iron', 2.5], ['house', 'plaster', 2.5],
      ]
      for (const [style, photo, meters] of walls) {
        const mat = wallByStyle.get(style)
        if (!mat) continue
        const f = TX.FACADE_SPECS[style]
        addWallDetail(mat, photos[photo], (f.bay * 8) / meters, (f.floor * 8) / meters)
      }
    },
    setNight(n: number) {
      night = n
      for (const m of wallMats) m.emissiveIntensity = n * 1.25
      for (const m of shopMats) m.emissiveIntensity = 0.12 + n * 1.3
      signMat.emissiveIntensity = 0.25 + n * 1.8
      adMat.emissiveIntensity = 0.2 + n * 1.6
      vendMat.emissiveIntensity = 0.5 + n * 1.2
      lampHeadMat.emissiveIntensity = n * 3.2
      poolMat.opacity = n * 0.42
    },
    update(time: number, broken: Uint8Array, brokenYaw: Float32Array) {
      // 信号
      signals.forEach((s, k) => {
        const light = CityMap.light(s.node![0], s.node![1], s.axis!, time)
        const on = light === 'green' ? 0 : light === 'yellow' ? 1 : 2
        for (let c = 0; c < 3; c++) lampMeshes[c].setColorAt(k, c === on ? ON[c] : OFF[c])
      })
      for (const lm of lampMeshes) lm.instanceColor!.needsUpdate = true
      // 倒れた街灯
      let changed = false
      lamps.forEach(([, i], k) => {
        if (!broken[i] || lampBroken[k]) return
        lampBroken[k] = 1
        changed = true
        const m = lampMatrix(k, true, brokenYaw[i])
        poleMesh.setMatrixAt(k, m)
        headMesh.setMatrixAt(k, m)
        m4.compose(p3.set(0, -100, 0), q.identity(), s3.set(0, 0, 0))
        poolMesh.setMatrixAt(k, m4)
      })
      if (changed) {
        poleMesh.instanceMatrix.needsUpdate = true
        headMesh.instanceMatrix.needsUpdate = true
        poolMesh.instanceMatrix.needsUpdate = true
      }
      void night
    },
    dispose() {
      for (const d of disposables) d.dispose()
      for (const im of [hills, poleMesh, headMesh, poolMesh, trunkMesh, leafMesh, sigPoleMesh, housingMesh, ...lampMeshes]) im.dispose()
    },
  }
}

/** 位置と法線だけの、インデックスなしの形をつなげる（木の葉用） */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = []
  for (const p of parts) {
    pos.push(...(p.attributes.position.array as Float32Array))
    p.dispose()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}
