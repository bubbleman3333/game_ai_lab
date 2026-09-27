// 植え込みの低木。写真スキャンのモデル（public/city/plants/、Poly Haven「shrub_02/03/04」・CC0）を使う。
//
// 1 つ数万ポリゴンあるので、街じゅうの数千か所に全部は置けない。
// 自分のまわり（NEAR m 以内）の植え込みだけを、種類ごとの InstancedMesh にまとめて描き、
// 自分が動いたら 0.5 秒ごとに置き直す。コンクリートの鉢（box）は軽いので同じように近くだけ描く。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CURB_HEIGHT, type CityMap } from '../sim/cityMap'

const BASE = `${import.meta.env.BASE_URL}city/plants/`
const MODELS = ['shrub_02', 'shrub_03', 'shrub_04']
const NEAR = 110
const MAX = 420

interface Part { geo: THREE.BufferGeometry; mat: THREE.Material; mesh: THREE.InstancedMesh }

export class Plants {
  readonly group = new THREE.Group()
  private parts: Part[][] = [[], [], []] // 種類ごとの部品（葉・枝など）
  private size: number[] = [1, 1, 1] // 種類ごとの元の高さ
  private boxes: THREE.InstancedMesh
  private timer = 0
  private map: CityMap

  constructor(map: CityMap, concrete: THREE.Material) {
    this.map = map
    const boxGeo = new THREE.BoxGeometry(1.3, 0.55, 1.3)
    boxGeo.translate(0, 0.275, 0)
    this.boxes = new THREE.InstancedMesh(boxGeo, concrete, MAX)
    this.boxes.count = 0
    this.boxes.castShadow = true
    this.boxes.receiveShadow = true
    this.group.add(this.boxes)
    const loader = new GLTFLoader()
    MODELS.forEach((name, k) => {
      loader.load(`${BASE}${name}/${name}.gltf`, (gltf) => {
        gltf.scene.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(gltf.scene)
        this.size[k] = Math.max(box.max.y - box.min.y, 0.1)
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          const geo = m.geometry.clone()
          geo.applyMatrix4(m.matrixWorld)
          geo.translate(0, -box.min.y, 0)
          const mat = m.material as THREE.MeshStandardMaterial
          mat.side = THREE.DoubleSide
          const mesh = new THREE.InstancedMesh(geo, mat, MAX)
          mesh.count = 0
          mesh.castShadow = true
          mesh.receiveShadow = true
          mesh.frustumCulled = false
          this.group.add(mesh)
          this.parts[k].push({ geo, mat, mesh })
        })
        this.timer = 0 // 読み込めたらすぐ置き直す
      })
    })
  }

  update(dt: number, x: number, z: number): void {
    this.timer -= dt
    if (this.timer > 0) return
    this.timer = 0.5
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3()
    const counts = [0, 0, 0]
    let boxes = 0
    const up = new THREE.Vector3(0, 1, 0)
    for (const pl of this.map.planters) {
      if (Math.abs(pl.x - x) > NEAR || Math.abs(pl.z - z) > NEAR) continue
      const k = pl.variant
      // 鉢植えは 0.55m の鉢の上に、生け垣・茂みは地面に（歩道・芝は縁石の高さ）
      let y = CURB_HEIGHT
      if (pl.kind === 'box' && boxes < MAX) {
        m.compose(p.set(pl.x, y, pl.z), q.setFromAxisAngle(up, pl.yaw), s.set(1, 1, 1))
        this.boxes.setMatrixAt(boxes++, m)
        y += 0.5
      }
      if (counts[k] >= MAX || this.parts[k].length === 0) continue
      // 高さをそろえる（鉢植え 0.9m・生け垣 1.1m・茂み 1.3m くらい）
      const h = (pl.kind === 'box' ? 0.9 : pl.kind === 'hedge' ? 1.1 : 1.3) * pl.scale
      const sc = h / this.size[k]
      m.compose(p.set(pl.x, y, pl.z), q.setFromAxisAngle(up, pl.yaw), s.set(sc, sc, sc))
      for (const part of this.parts[k]) part.mesh.setMatrixAt(counts[k], m)
      counts[k]++
    }
    this.boxes.count = boxes
    this.boxes.instanceMatrix.needsUpdate = true
    this.parts.forEach((parts, k) => {
      for (const part of parts) {
        part.mesh.count = counts[k]
        part.mesh.instanceMatrix.needsUpdate = true
      }
    })
  }

  dispose(): void {
    this.boxes.geometry.dispose()
    this.boxes.dispose()
    for (const parts of this.parts) for (const part of parts) { part.geo.dispose(); part.mat.dispose(); part.mesh.dispose() }
  }
}
