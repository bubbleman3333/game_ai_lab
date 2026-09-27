// 車の 3D モデル。箱を並べるのではなく、横から見た輪郭（シルエット）を描いて車幅ぶん押し出し、
// そのあと頂点を動かして「上から見て角が丸い」「屋根ほど幅がすぼまる」「ボンネットが丸く盛り上がる」
// 形に整える。塗装はクリアコートつきの金属塗装にして、空や街の明かりが映り込むようにしてある。
//
// 形の元（テンプレート）は車種ごとに 1 回だけ作り、車ごとに複製して持つ。
// 複製を持つのは、ぶつかった場所の頂点を押し込んで「へこみ」を残すため（dent()）。
// へこみは sim/game.ts の Vehicle.dents（車のローカル座標）を読んで反映する。
//
// 座標は車のローカル: x = 左、y = 上、z = 前（three.js で rotation.y = yaw にすると x が運転者の左になる）。

import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { VehicleType } from '../sim/vehicle'

interface Profile {
  length: number
  width: number
  /** 車体の下端・ベルトライン（窓の下端）・屋根の高さ */
  bottom: number
  belt: number
  roof: number
  /** 前輪・後輪の位置（z）とタイヤの半径 */
  wf: number
  wr: number
  wheel: number
  /** 窓の付け根（前）・屋根の前端・屋根の後端・窓の付け根（後ろ） */
  cowl: number
  roofF: number
  roofR: number
  deck: number
  /** 鼻先の高さ・後ろの上端の高さ（セダンのトランク） */
  nose: number
  tail: number
  /** ホイールの色（スポーツカーは黒、など） */
  rim: number
  caliper: number
}

const PROFILES: Record<VehicleType, Profile> = {
  sport: { length: 4.45, width: 1.95, bottom: 0.24, belt: 0.9, roof: 1.24, wf: 1.42, wr: -1.36, wheel: 0.36,
           cowl: 0.5, roofF: -0.12, roofR: -0.95, deck: -1.78, nose: 0.6, tail: 0.94, rim: 0x2a2c30, caliper: 0xd02020 },
  sedan: { length: 4.75, width: 1.84, bottom: 0.3, belt: 0.95, roof: 1.45, wf: 1.45, wr: -1.4, wheel: 0.34,
           cowl: 0.85, roofF: 0.2, roofR: -0.95, deck: -1.6, nose: 0.72, tail: 0.98, rim: 0xc4c9cf, caliper: 0x555555 },
  hatch: { length: 3.95, width: 1.72, bottom: 0.3, belt: 0.95, roof: 1.5, wf: 1.25, wr: -1.2, wheel: 0.32,
           cowl: 0.75, roofF: 0.2, roofR: -1.55, deck: -1.9, nose: 0.72, tail: 1.2, rim: 0xb9bec6, caliper: 0x555555 },
  taxi: { length: 4.7, width: 1.8, bottom: 0.3, belt: 0.95, roof: 1.5, wf: 1.43, wr: -1.4, wheel: 0.34,
          cowl: 0.85, roofF: 0.2, roofR: -0.95, deck: -1.6, nose: 0.72, tail: 0.98, rim: 0x9aa0a8, caliper: 0x555555 },
  van: { length: 5.2, width: 2.0, bottom: 0.36, belt: 1.12, roof: 2.15, wf: 1.75, wr: -1.65, wheel: 0.38,
         cowl: 1.95, roofF: 1.45, roofR: -2.5, deck: -2.58, nose: 0.9, tail: 2.1, rim: 0xd0d4d8, caliper: 0x555555 },
  suv: { length: 4.8, width: 1.95, bottom: 0.4, belt: 1.12, roof: 1.78, wf: 1.45, wr: -1.45, wheel: 0.4,
         cowl: 0.95, roofF: 0.35, roofR: -2.05, deck: -2.35, nose: 0.9, tail: 1.6, rim: 0x3a3d42, caliper: 0x555555 },
  police: { length: 4.8, width: 1.86, bottom: 0.3, belt: 0.95, roof: 1.46, wf: 1.46, wr: -1.42, wheel: 0.35,
            cowl: 0.85, roofF: 0.2, roofR: -0.95, deck: -1.62, nose: 0.72, tail: 0.98, rim: 0xc4c9cf, caliper: 0x555555 },
}

export const profileOf = (t: VehicleType) => PROFILES[t]

const BEVEL = 0.08

/** 横から見た車体の輪郭。下の辺にホイールアーチを切り欠く */
function bodyShape(p: Profile): THREE.Shape {
  const zr = -p.length / 2 + BEVEL, zf = p.length / 2 - BEVEL
  const y0 = p.bottom
  const s = new THREE.Shape()
  const arch = (zc: number) => {
    const ar = p.wheel + 0.08
    const th = Math.asin(Math.max(-1, (y0 - p.wheel) / ar))
    const dx = ar * Math.cos(th)
    s.lineTo(zc - dx - 0.04, y0)
    s.lineTo(zc - dx, y0 + 0.02)
    s.absarc(zc, p.wheel, ar, Math.PI - th, th, true)
    s.lineTo(zc + dx + 0.04, y0)
  }
  s.moveTo(zr + 0.2, y0)
  arch(p.wr)
  arch(p.wf)
  s.lineTo(zf - 0.25, y0)
  s.quadraticCurveTo(zf + 0.02, y0, zf, y0 + 0.24)
  s.lineTo(zf - 0.01, p.nose - 0.14)
  s.quadraticCurveTo(zf, p.nose, zf - 0.3, p.nose + 0.04)
  // ボンネット → 窓の付け根（なだらかに盛り上がる）
  s.bezierCurveTo(zf - 0.8, p.nose + 0.12, p.cowl + 0.4, p.belt - 0.02, p.cowl, p.belt)
  s.lineTo(p.deck, p.belt)
  // トランク・リアゲート
  if (p.tail > p.belt + 0.15) {
    s.quadraticCurveTo(zr + 0.1, p.tail - 0.05, zr + 0.04, p.tail)
  } else {
    s.quadraticCurveTo(p.deck - 0.2, p.tail + 0.02, zr + 0.3, p.tail)
    s.quadraticCurveTo(zr, p.tail, zr, p.tail - 0.2)
  }
  s.lineTo(zr, y0 + 0.22)
  s.quadraticCurveTo(zr - 0.02, y0, zr + 0.2, y0)
  return s
}

/** 窓（ガラスの部分） */
function cabinShape(p: Profile): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(p.cowl - 0.02, p.belt - 0.02)
  s.bezierCurveTo(p.cowl - 0.25, p.belt + 0.15, p.roofF + 0.3, p.roof - 0.03, p.roofF, p.roof)
  s.lineTo(p.roofR, p.roof)
  if (p.tail > p.belt + 0.15) s.quadraticCurveTo(p.deck + 0.02, p.roof - 0.05, p.deck + 0.05, Math.max(p.tail - 0.15, p.belt + 0.3))
  s.quadraticCurveTo(p.deck + 0.12, p.belt + 0.08, p.deck, p.belt - 0.02)
  s.lineTo(p.cowl - 0.02, p.belt - 0.02)
  return s
}

/**
 * 輪郭を横幅 width で押し出し、車の向き（z が前）に回して中心をそろえる。
 * 幅の方向にも細かく分けておく（あとで丸めたり、へこませたりするため）
 */
function extrude(shape: THREE.Shape, width: number, bevel: number, steps: number): THREE.BufferGeometry {
  const depth = width - bevel * 2
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, steps, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 18,
  })
  g.rotateY(-Math.PI / 2)
  g.translate(depth / 2, 0, 0)
  return g
}

/** 押し出しただけの板っぽい形を、車らしい丸みのある形に整える */
function sculpt(g: THREE.BufferGeometry, p: Profile, tumble: number): THREE.BufferGeometry {
  const pos = g.attributes.position
  const hw = p.width / 2, hl = p.length / 2
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const xn = Math.min(1, Math.abs(x) / hw)
    const zn = Math.min(1, Math.abs(z) / hl)
    // 上から見て、前後の端ほど幅を細く（角を丸く）
    const end = Math.max(0, (zn - 0.62) / 0.38)
    x *= 1 - 0.16 * end * end
    // 横の端ほど前後を短く（角を丸く）
    z *= 1 - 0.03 * xn ** 4
    // 屋根ほど幅をすぼめる（タンブルホーム）
    const up = Math.max(0, (y - p.belt + 0.25) / (p.roof - p.belt + 0.25))
    x *= 1 - tumble * up
    // ボンネット・トランク・屋根を少し丸く盛り上げる
    if (y > p.bottom + 0.3) y += 0.035 * (1 - xn * xn) * Math.min(1, (y - p.bottom - 0.3) * 3)
    pos.setXYZ(i, x, y, z)
  }
  // 頂点をつなぎ直して、なめらかな陰影にする（押し出したままだと面ごとに角ばって見える）
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  const m = mergeVertices(g, 1e-4)
  g.dispose()
  m.computeVertexNormals()
  return m
}

function mergeGeos(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = []
  for (const p of parts) {
    const g = p.index ? p.toNonIndexed() : p
    pos.push(...(g.attributes.position.array as Float32Array))
    nor.push(...(g.attributes.normal.array as Float32Array))
    if (g !== p) g.dispose()
    p.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return out
}

/** 角の丸い箱（バンパーなど） */
function rbox(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.03): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const hw = w / 2 - r, hh = h / 2 - r
  s.moveTo(-hw, -h / 2)
  s.lineTo(hw, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -hh)
  s.lineTo(w / 2, hh); s.quadraticCurveTo(w / 2, h / 2, hw, h / 2)
  s.lineTo(-hw, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, hh)
  s.lineTo(-w / 2, -hh); s.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2)
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 4 })
  g.translate(x, y, z - d / 2)
  return g
}

interface Template {
  body: THREE.BufferGeometry
  cabin: THREE.BufferGeometry
  trim: THREE.BufferGeometry
  chrome: THREE.BufferGeometry
  heads: THREE.BufferGeometry
  lens: THREE.BufferGeometry
  tails: THREE.BufferGeometry
  plates: THREE.BufferGeometry
  tire: THREE.BufferGeometry
  rim: THREE.BufferGeometry
  disc: THREE.BufferGeometry
  caliper: THREE.BufferGeometry
}

function buildTemplate(type: VehicleType): Template {
  const p = PROFILES[type]
  const L = p.length, W = p.width
  const zf = L / 2, zr = -L / 2
  const x = W / 2
  const cz = (p.roofF + p.roofR) / 2
  const body = sculpt(extrude(bodyShape(p), W, BEVEL, 14), p, 0.05)
  const cabin = sculpt(extrude(cabinShape(p), W - 0.16, 0.06, 8), p, 0.14)

  const trim: THREE.BufferGeometry[] = [
    rbox(W - 0.06, 0.2, 0.2, 0, p.bottom + 0.12, zf - 0.08, 0.06), // 前バンパーの下部
    rbox(W - 0.06, 0.2, 0.2, 0, p.bottom + 0.12, zr + 0.08, 0.06),
    rbox(0.06, 0.1, L * 0.5, x - 0.03, p.bottom + 0.05, 0), // サイドステップ
    rbox(0.06, 0.1, L * 0.5, -x + 0.03, p.bottom + 0.05, 0),
    rbox(W * 0.62, 0.02, 0.02, 0, p.belt - 0.005, 0), // ベルトラインのモール（見えるのは端だけ）
  ]
  // グリル（横桟）
  for (let k = 0; k < 4; k++) trim.push(rbox(W * 0.5, 0.025, 0.05, 0, p.bottom + 0.3 + k * 0.05, zf - 0.02, 0.01))
  // ドアの合わせ目（細い溝）
  const doorZ = p.tail > p.belt + 0.15 ? [p.cowl - 0.05, cz + 0.05, p.roofR + 0.1] : [p.cowl - 0.05, cz, p.roofR - 0.1]
  for (const dz of doorZ) for (const side of [1, -1]) {
    trim.push(rbox(0.012, p.belt - p.bottom - 0.2, 0.012, side * (x - 0.02), (p.belt + p.bottom) / 2 + 0.05, dz, 0.004))
  }
  // 窓枠（ピラー）
  for (const side of [1, -1]) {
    trim.push(rbox(0.05, (p.roof - p.belt) * 0.95, 0.07, side * (x - 0.13), (p.roof + p.belt) / 2, cz, 0.02))
    // ドアミラー
    trim.push(rbox(0.05, 0.03, 0.1, side * (x + 0.02), p.belt + 0.02, p.cowl - 0.25))
    trim.push(rbox(0.18, 0.11, 0.1, side * (x + 0.1), p.belt + 0.08, p.cowl - 0.28, 0.04))
  }
  const chrome = mergeGeos([
    new THREE.CylinderGeometry(0.045, 0.05, 0.22, 12).rotateX(Math.PI / 2).translate(x * 0.55, p.bottom + 0.07, zr - 0.02),
    ...(type === 'sport' ? [new THREE.CylinderGeometry(0.045, 0.05, 0.22, 12).rotateX(Math.PI / 2).translate(-x * 0.55, p.bottom + 0.07, zr - 0.02)] : []),
    ...[1, -1].map((side) => rbox(0.02, 0.025, 0.2, side * (x - 0.005), p.belt - 0.26, p.cowl - 0.6, 0.01)),
    ...[1, -1].map((side) => rbox(0.02, 0.025, 0.2, side * (x - 0.005), p.belt - 0.26, cz - 0.2, 0.01)),
    new THREE.CylinderGeometry(0.004, 0.006, 0.4, 5).rotateX(-0.3).translate(-x * 0.6, p.roof + 0.18, p.roofR + 0.1), // アンテナ
  ].map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { g.computeVertexNormals(); return g }))
  // ヘッドライト: 奥の反射板（光る）と手前の透明なレンズ
  const heads = mergeGeos([1, -1].map((side) => rbox(0.44, 0.13, 0.08, side * (x - 0.36), p.nose - 0.12, zf - 0.07, 0.04)))
  const lens = mergeGeos([1, -1].map((side) =>
    new THREE.SphereGeometry(0.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(0.9, 0.3, 0.25)
      .translate(side * (x - 0.36), p.nose - 0.12, zf - 0.04)))
  const tails = mergeGeos([1, -1].map((side) => rbox(0.44, 0.13, 0.08, side * (x - 0.3), p.tail - 0.2, zr + 0.05, 0.03)))
  const plates = mergeGeos([
    rbox(0.52, 0.16, 0.03, 0, p.bottom + 0.3, zf - 0.02),
    rbox(0.52, 0.16, 0.03, 0, p.bottom + 0.4, zr + 0.0),
  ].map((g) => { g.computeVertexNormals(); return g }))

  // タイヤ: 側面が丸くふくらんだ回転体。ホイール: リム・5 本のスポーク・中心
  const R = p.wheel, T = 0.24
  const tire = new THREE.LatheGeometry([
    [R * 0.66, -T / 2], [R * 0.9, -T / 2 - 0.005], [R * 0.98, -T / 2 + 0.02], [R, -T / 2 + 0.06], [R, T / 2 - 0.06],
    [R * 0.98, T / 2 - 0.02], [R * 0.9, T / 2 + 0.005], [R * 0.66, T / 2],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 28).rotateZ(Math.PI / 2)
  tire.computeVertexNormals()
  const rimParts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(R * 0.67, R * 0.67, T * 0.9, 28, 1, true).rotateZ(Math.PI / 2),
    new THREE.CylinderGeometry(R * 0.16, R * 0.18, T * 0.95, 12).rotateZ(Math.PI / 2),
    new THREE.TorusGeometry(R * 0.64, 0.018, 6, 28).rotateY(Math.PI / 2).translate(T * 0.42, 0, 0),
    new THREE.TorusGeometry(R * 0.64, 0.018, 6, 28).rotateY(Math.PI / 2).translate(-T * 0.42, 0, 0),
  ]
  for (let k = 0; k < 5; k++) {
    for (const side of [1, -1]) {
      const s = new THREE.BoxGeometry(0.03, R * 0.5, 0.06)
      s.translate(side * T * 0.4, R * 0.4, 0)
      s.rotateX((k / 5) * Math.PI * 2)
      rimParts.push(s)
    }
  }
  const rim = mergeGeos(rimParts.map((g) => { g.computeVertexNormals(); return g }))
  const disc = new THREE.CylinderGeometry(R * 0.55, R * 0.55, 0.03, 20).rotateZ(Math.PI / 2)
  const caliper = new THREE.BoxGeometry(0.06, R * 0.3, R * 0.35).translate(0, R * 0.4, -R * 0.15)
  return { body, cabin, trim: mergeGeos(trim.map((g) => { g.computeVertexNormals(); return g })), chrome, heads, lens, tails, plates, tire, rim, disc, caliper }
}

const cache = new Map<VehicleType, Template>()
const template = (t: VehicleType): Template => {
  let v = cache.get(t)
  if (!v) { v = buildTemplate(t); cache.set(t, v) }
  return v
}

// --- 共有のマテリアル --------------------------------------------------------------------
const MAT = {
  trim: new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.55, metalness: 0.2 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.12, metalness: 1 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.88 }),
  disc: new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.4, metalness: 0.9 }),
  plate: new THREE.MeshStandardMaterial({ color: 0xf2f2ea, roughness: 0.45 }),
  head: new THREE.MeshStandardMaterial({ color: 0xe8ecf2, emissive: 0xfff3dc, emissiveIntensity: 0.3, roughness: 0.15, metalness: 0.6 }),
  lens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, roughness: 0.02, clearcoat: 1, depthWrite: false }),
}
const rimMats = new Map<number, THREE.MeshStandardMaterial>()
const rimMat = (c: number) => {
  let m = rimMats.get(c)
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.22, metalness: 0.95 }); rimMats.set(c, m) }
  return m
}
const caliperMats = new Map<number, THREE.MeshStandardMaterial>()
const caliperMat = (c: number) => {
  let m = caliperMats.get(c)
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }); caliperMats.set(c, m) }
  return m
}

/** 夜にヘッドライトが道を照らす光（本物のライトは自分の車だけ。ほかは地面に光の絵を敷く） */
const glowMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })

export function setCarNight(n: number, glow: THREE.Texture): void {
  MAT.head.emissiveIntensity = 0.3 + n * 4
  if (glowMat.map !== glow) { glowMat.map = glow; glowMat.needsUpdate = true }
  glowMat.opacity = n * 0.55
}

export interface CarModel {
  group: THREE.Group
  body: THREE.Group
  wheels: THREE.Object3D[]
  frontPivots: THREE.Object3D[]
  paint: THREE.MeshPhysicalMaterial
  tail: THREE.MeshStandardMaterial
  glassMat: THREE.MeshPhysicalMaterial
  /** パトカーの回転灯（赤・青）。無ければ null */
  siren: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] | null
  glass: THREE.Mesh
  heads: THREE.Mesh
  glow: THREE.Mesh
  profile: Profile
  /** 反映済みのへこみの数 */
  dentCount: number
  /** へこみを 1 つ反映する（x = 左、z = 前、k = 強さ） */
  dent(x: number, z: number, k: number): void
  dispose(): void
}

/** 側面の文字（パトカー・タクシー） */
function decal(text: string, color: string, bg: string | null, w: number, h: number): THREE.Mesh {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 128
  const g = c.getContext('2d')!
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, 512, 128) }
  g.fillStyle = color
  g.font = 'bold 76px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 256, 68)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2 }))
}

/** 頂点を押し込んでへこませる。中心 (x, z) から半径 R の中を、車の中心へ向かって押す */
function pushIn(g: THREE.BufferGeometry, p: Profile, x: number, z: number, k: number, seed: number): void {
  const pos = g.attributes.position
  const R = 0.55 + k * 0.55
  const depth = 0.12 + k * 0.22
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i)
    // 横から当たったか前後から当たったかで、効く範囲の形を変える（縦には広く効く）
    const d = Math.hypot(vx - x, vz - z)
    if (d >= R) continue
    const f = (1 - d / R) ** 2 * depth * (0.75 + 0.5 * Math.abs(Math.sin(i * 12.9898 + seed)))
    // 車の中心へ向かう向き（横から当たれば横へ、前から当たれば後ろへ）
    let nx = -vx / (p.width / 2), nz = -vz / (p.length / 2)
    const n = Math.hypot(nx, nz) || 1
    nx /= n; nz /= n
    pos.setXYZ(i, vx + nx * f, vy - f * 0.25 * (vy > p.belt ? 1 : 0.3), vz + nz * f)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
}

export function buildCarModel(type: VehicleType, color: number): CarModel {
  const p = PROFILES[type]
  const t = template(type)
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  const own: { dispose(): void }[] = []

  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04 })
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0808, emissive: 0xff1a10, emissiveIntensity: 0.25, roughness: 0.15 })
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a1016, metalness: 0.85, roughness: 0.04, clearcoat: 1 })
  own.push(paint, tail, glassMat)
  // 車ごとに形を複製する（へこませるため）
  const bodyGeo = t.body.clone()
  const cabinGeo = t.cabin.clone()
  own.push(bodyGeo, cabinGeo)
  const add = (g: THREE.BufferGeometry, m: THREE.Material, shadow = true) => {
    const mesh = new THREE.Mesh(g, m)
    mesh.castShadow = shadow
    mesh.receiveShadow = shadow
    body.add(mesh)
    return mesh
  }
  // パトカーは下が黒・上（ドア・屋根）が白（日本のパトカー風）
  let lower = paint
  if (type === 'police') {
    lower = new THREE.MeshPhysicalMaterial({ color: 0x0c0d10, metalness: 0.5, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04 })
    own.push(lower)
  }
  add(bodyGeo, lower)
  const glass = add(cabinGeo, glassMat)
  add(t.trim, MAT.trim, false)
  add(t.chrome, MAT.chrome, false)
  const heads = add(t.heads, MAT.head, false)
  add(t.lens, MAT.lens, false)
  add(t.tails, tail, false)
  add(t.plates, MAT.plate, false)
  if (type === 'police') {
    for (const side of [1, -1]) {
      const door = decal('警察', '#111', '#f4f4f4', 1.9, 0.5)
      door.position.set(side * (p.width / 2 - 0.035), p.belt - 0.3, 0.05)
      door.rotation.y = side * Math.PI / 2
      body.add(door)
      own.push(door.geometry, door.material as THREE.Material)
    }
  }
  if (type === 'taxi') {
    for (const side of [1, -1]) {
      const d = decal('TAXI', '#111', null, 1.2, 0.3)
      d.position.set(side * (p.width / 2 - 0.035), p.belt - 0.25, -0.2)
      d.rotation.y = side * Math.PI / 2
      body.add(d)
      own.push(d.geometry, d.material as THREE.Material)
    }
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 0.25),
      new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffc040, emissiveIntensity: 0.8 }))
    sign.position.set(0, p.roof + 0.14, (p.roofF + p.roofR) / 2)
    body.add(sign)
    own.push(sign.geometry, sign.material as THREE.Material)
  }
  let siren: CarModel['siren'] = null
  if (type === 'police') {
    const red = new THREE.MeshBasicMaterial({ color: 0x300000, toneMapped: false })
    const blue = new THREE.MeshBasicMaterial({ color: 0x000030, toneMapped: false })
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.3), MAT.trim)
    bar.position.set(0, p.roof + 0.07, (p.roofF + p.roofR) / 2 + 0.2)
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.26), red)
    l.position.set(0.3, p.roof + 0.11, bar.position.z)
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.26), blue)
    r.position.set(-0.3, p.roof + 0.11, bar.position.z)
    body.add(bar, l, r)
    siren = [red, blue]
    own.push(bar.geometry, l.geometry, r.geometry, red, blue)
  }

  // タイヤ（車体の傾きとは関係なく地面に着ける）
  const wheels: THREE.Object3D[] = []
  const frontPivots: THREE.Object3D[] = []
  for (const [z, front] of [[p.wf, true], [p.wr, false]] as [number, boolean][]) {
    for (const side of [1, -1]) {
      const pivot = new THREE.Group()
      pivot.position.set(side * (p.width / 2 - 0.2), p.wheel, z)
      const spin = new THREE.Group()
      const tire = new THREE.Mesh(t.tire, MAT.tire)
      tire.castShadow = true
      spin.add(tire, new THREE.Mesh(t.rim, rimMat(p.rim)), new THREE.Mesh(t.disc, MAT.disc))
      const cal = new THREE.Mesh(t.caliper, caliperMat(p.caliper)) // キャリパーは回らない
      pivot.add(spin, cal)
      group.add(pivot)
      wheels.push(spin)
      if (front) frontPivots.push(pivot)
    }
  }

  const glow = new THREE.Mesh(new THREE.PlaneGeometry(5, 12), glowMat)
  glow.rotation.x = -Math.PI / 2
  glow.position.set(0, 0.04, p.length / 2 + 6)
  group.add(glow)
  own.push(glow.geometry)

  const model: CarModel = {
    group, body, wheels, frontPivots, paint, tail, glassMat, siren, glass, heads, glow, profile: p, dentCount: 0,
    dent(x: number, z: number, k: number) {
      pushIn(bodyGeo, p, x, z, k, model.dentCount * 7.1)
      pushIn(cabinGeo, p, x, z, k * 0.8, model.dentCount * 3.3)
      // 強く当たるとガラスが割れて白く曇る
      if (k > 0.45) {
        glassMat.color.setHex(0x8e999f)
        glassMat.roughness = 0.55
        glassMat.metalness = 0.3
        glassMat.clearcoat = 0.2
      }
      // 前から強く当たるとヘッドライトが割れて消える
      if (k > 0.35 && z > p.length / 2 - 0.7) { heads.visible = false; glow.visible = false }
    },
    dispose() { for (const d of own) d.dispose() },
  }
  return model
}
