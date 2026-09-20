// carDesigns.ts の寸法表から、車の 3D モデルを組み立てる。
//
// three.js の言葉を少しだけ:
//   Geometry  形（箱・円柱などの頂点の集まり）
//   Material  表面の色や質感
//   Mesh      Geometry と Material を合わせた「置ける物体」
//   Group     Mesh をまとめて 1 つとして動かす入れ物
// ここでは「車体の各パーツの Mesh」と「タイヤ 4 本の Mesh」を 1 つの Group にまとめて返す。

import * as THREE from 'three'
import { designFor, type CarDesign, type Part } from './carDesigns'

/** 前が低くなった台形（ボンネット）。箱の前側の上の頂点だけを下げて作る */
function wedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > 0 && pos.getY(i) > 0) pos.setY(i, pos.getY(i) - h * 0.62)
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  return g
}

function partMaterial(p: Part): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: p.color,
    metalness: p.metal ?? 0.1,
    roughness: p.rough ?? 0.45,
    emissive: p.glow ? p.color : 0x000000,
    emissiveIntensity: p.glow ?? 0,
  })
}

function partMesh(p: Part): THREE.Mesh {
  const [w, h, d] = p.size
  const geo = p.shape === 'cylinder'
    ? new THREE.CylinderGeometry(w / 2, w / 2, h, 14)
    : p.shape === 'wedge' ? wedgeGeometry(w, h, d) : new THREE.BoxGeometry(w, h, d)
  const mesh = new THREE.Mesh(geo, partMaterial(p))
  mesh.castShadow = true
  mesh.rotation.x = p.rotX ?? 0
  mesh.rotation.z = p.rotZ ?? 0
  return mesh
}

export interface CarModel {
  /** 場面に置くもの。位置と向きはこの Group に入れる */
  group: THREE.Group
  /** 車体だけ（サスペンションの上下や傾きをつけるための入れ子） */
  body: THREE.Group
  /** タイヤ。速度に合わせて回す */
  wheels: THREE.Mesh[]
  /** 前輪を載せた入れ物。ステアに合わせて y 軸まわりに回す */
  frontWheels: THREE.Object3D[]
  /** 地面に落とす丸い影 */
  shadow: THREE.Mesh
  dispose(): void
}

/**
 * 車 1 台ぶんのモデルを作る。
 * color を渡すと、いちばん面積の大きいパーツ（＝ボディ）の色を塗り替える（AI の車を色違いにする用）。
 */
export function buildCar(carId: string, color?: number): CarModel {
  const design: CarDesign = designFor(carId)
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  const disposables: { dispose(): void }[] = []

  // いちばん体積の大きいパーツをボディとみなして色を差し替える
  const volume = (p: Part) => p.size[0] * p.size[1] * p.size[2]
  const main = design.parts.reduce((a, b) => (volume(a) >= volume(b) ? a : b))

  for (const p of design.parts) {
    const spec: Part = color !== undefined && (p === main || p.color === main.color) && !p.glow
      ? { ...p, color }
      : p
    for (const side of spec.mirror ? [1, -1] : [1]) {
      const mesh = partMesh(spec)
      mesh.position.set(spec.at[0] * side, spec.at[1], spec.at[2])
      if (side < 0) mesh.rotation.z = -(spec.rotZ ?? 0)
      body.add(mesh)
      disposables.push(mesh.geometry, mesh.material as THREE.Material)
    }
  }

  // タイヤ: 円柱を横に倒して置く
  const w = design.wheel
  const wheelGeo = new THREE.CylinderGeometry(w.radius, w.radius, w.width, 18)
  const wheelMat = new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.85 })
  const hubGeo = new THREE.CylinderGeometry(w.radius * 0.45, w.radius * 0.45, w.width * 1.05, 10)
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xb8bec8, metalness: 0.8, roughness: 0.3 })
  disposables.push(wheelGeo, wheelMat, hubGeo, hubMat)

  const wheels: THREE.Mesh[] = []
  const frontWheels: THREE.Object3D[] = []
  for (const [z, isFront] of [[w.front, true], [w.back, false]] as [number, boolean][]) {
    for (const side of [1, -1]) {
      // 前輪は「ステアで向きを変える入れ物」に入れてから、その中でタイヤを回す
      const pivot = new THREE.Group()
      pivot.position.set(w.side * side, w.radius, z)
      const wheel = new THREE.Mesh(wheelGeo, wheelMat)
      wheel.rotation.z = Math.PI / 2 // 円柱を横倒しにする
      wheel.castShadow = true
      const hub = new THREE.Mesh(hubGeo, hubMat)
      hub.rotation.z = Math.PI / 2
      wheel.add(hub)
      pivot.add(wheel)
      body.add(pivot)
      wheels.push(wheel)
      if (isFront) frontWheels.push(pivot)
    }
  }

  // 丸い影（本物の影とは別に、車の真下に薄い楕円を敷いて接地感を出す）
  const shadowGeo = new THREE.CircleGeometry(0.5, 20)
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
  const shadow = new THREE.Mesh(shadowGeo, shadowMat)
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.set(design.shadow[0], design.shadow[1], 1)
  group.add(shadow)
  disposables.push(shadowGeo, shadowMat)

  return {
    group, body, wheels, frontWheels, shadow,
    dispose() { for (const d of disposables) d.dispose() },
  }
}
