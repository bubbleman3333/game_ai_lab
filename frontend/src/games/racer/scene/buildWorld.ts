// コースのまわりの景色（空・大地・遠くの山・木や岩や街灯）を組み立てる。
//
// 飾りはすべて中心線に沿って自動で並ぶので、コースを 1 つ足せば景色も勝手についてくる。
// 何をどれだけ並べるかは themes.ts の props で決まる。
//
// 木や岩は同じ形を何百個も置くことになる。1 個ずつ Mesh を作ると重いので、
// three.js の InstancedMesh（同じ形をまとめて 1 回で描く仕組み）を使っている。

import * as THREE from 'three'
import * as CO from '../engine/course'
import { edgePoint } from './buildTrack'
import type { PropSpec, Theme } from './themes'

const APRON_INNER = 26 // 道の高さに沿わせる範囲（道の端から m）
const APRON_OUTER = 90 // ここまでで地面の高さに戻す
const GROUND_SIZE = 4000
const HILL_COUNT = 46
const HILL_RADIUS = 950

/** 同じ順番で同じ配置になる乱数（見るたびに木が動かないように） */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 飾り 1 種類の形を、パーツごとの (形, 材質, 変形) で返す */
function propParts(spec: PropSpec): { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] {
  const base = (color: number, glow = false, rough = 0.8) => new THREE.MeshStandardMaterial({
    color, roughness: rough,
    emissive: glow ? color : 0x000000, emissiveIntensity: glow ? 1.6 : 0,
  })
  const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(),
                                new THREE.Vector3(sx, sy, sz))
  const c2 = spec.color2 ?? spec.color

  switch (spec.shape) {
    case 'tree':
      return [
        { geo: new THREE.CylinderGeometry(0.09, 0.13, 1, 7), mat: base(spec.color), local: at(0, 0.5, 0) },
        { geo: new THREE.ConeGeometry(0.42, 1.25, 8), mat: base(c2, false, 0.9), local: at(0, 1.3, 0) },
        { geo: new THREE.ConeGeometry(0.32, 0.95, 8), mat: base(c2, false, 0.9), local: at(0, 1.85, 0) },
      ]
    case 'cactus':
      return [
        { geo: new THREE.CylinderGeometry(0.17, 0.2, 1.6, 9), mat: base(spec.color), local: at(0, 0.8, 0) },
        { geo: new THREE.CylinderGeometry(0.1, 0.1, 0.6, 7), mat: base(spec.color), local: at(0.28, 1.0, 0, 1, 1, 1) },
        { geo: new THREE.CylinderGeometry(0.1, 0.1, 0.5, 7), mat: base(spec.color), local: at(-0.26, 1.25, 0) },
      ]
    case 'rock':
      return [{ geo: new THREE.IcosahedronGeometry(0.6, 0), mat: base(spec.color, false, 1), local: at(0, 0.4, 0) }]
    case 'lamp':
      return [
        { geo: new THREE.CylinderGeometry(0.07, 0.1, 1, 6), mat: base(spec.color, false, 0.6), local: at(0, 0.5, 0) },
        { geo: new THREE.SphereGeometry(0.17, 10, 8), mat: base(c2, spec.glow), local: at(0, 1.03, 0) },
      ]
    case 'tower':
      return [
        { geo: new THREE.BoxGeometry(1, 1, 1), mat: base(spec.color, false, 0.95), local: at(0, 0.5, 0, 0.5, 1, 0.5) },
        { geo: new THREE.BoxGeometry(1, 1, 1), mat: base(c2, spec.glow), local: at(0, 0.55, 0.255, 0.16, 0.8, 0.02) },
        { geo: new THREE.BoxGeometry(1, 1, 1), mat: base(c2, spec.glow), local: at(0.255, 0.45, 0, 0.02, 0.6, 0.16) },
      ]
  }
}

export interface WorldModel {
  group: THREE.Group
  sun: THREE.DirectionalLight
  dispose(): void
}

export function buildWorld(c: CO.Course, t: Theme): WorldModel {
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []
  const base = Math.min(...c.y) - 1.5 // 平らな大地の高さ

  // --- 空（内側から見る大きな球にグラデーションを塗る）-------------------------
  const skyGeo = new THREE.SphereGeometry(2600, 24, 16)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(t.skyTop) },
      bottom: { value: new THREE.Color(t.skyBottom) },
    },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ gl_FragColor = vec4(mix(bottom, top, clamp(h*1.4+0.15,0.0,1.0)), 1.0); }',
  })
  group.add(new THREE.Mesh(skyGeo, skyMat))
  disposables.push(skyGeo, skyMat)

  // --- 大地 -------------------------------------------------------------------
  const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE)
  const groundMat = new THREE.MeshStandardMaterial({ color: t.ground, roughness: 1 })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = base
  ground.receiveShadow = true
  group.add(ground)
  disposables.push(groundGeo, groundMat)

  // 道の高さに沿って盛り上がる大地（丘や谷に見せる）。道が途切れている区間は作らない
  if (t.terrain === 'follow') {
    const pos: number[] = []
    const bands = [
      [c.width[0] / 2 + 1.2, APRON_INNER, 1, 1],
      [APRON_INNER, APRON_OUTER, 1, 0],
    ]
    for (let i = 0; i < c.n; i++) {
      const j = (i + 1) % c.n
      if (c.kind[i] === CO.KIND_GAP || c.kind[j] === CO.KIND_GAP) continue
      for (const side of [-1, 1]) {
        for (const [o0, o1, w0, w1] of bands) {
          const lift = (p: [number, number, number], w: number) => {
            p[1] = base + (p[1] - base) * w
            return p
          }
          const a = lift(edgePoint(c, i, side * o0), w0)
          const b = lift(edgePoint(c, i, side * o1), w1)
          const d = lift(edgePoint(c, j, side * o1), w1)
          const e = lift(edgePoint(c, j, side * o0), w0)
          for (const p of [a, e, d, a, d, b]) pos.push(p[0], p[1] - 0.15, p[2])
        }
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: t.ground, roughness: 1, side: THREE.DoubleSide,
    }))
    mesh.receiveShadow = true
    group.add(mesh)
    disposables.push(geo, mesh.material as THREE.Material)
  }

  // --- 遠くの山（コースを囲むように円く並べる）--------------------------------
  const cx = (Math.min(...c.x) + Math.max(...c.x)) / 2
  const cz = (Math.min(...c.z) + Math.max(...c.z)) / 2
  const hillGeo = new THREE.ConeGeometry(1, 1, 5)
  const hillMat = new THREE.MeshStandardMaterial({ color: t.hills, roughness: 1, flatShading: true })
  const hills = new THREE.InstancedMesh(hillGeo, hillMat, HILL_COUNT)
  const r = rng(7)
  for (let i = 0; i < HILL_COUNT; i++) {
    const ang = (i / HILL_COUNT) * Math.PI * 2 + r() * 0.1
    const dist = HILL_RADIUS * (0.75 + r() * 0.6)
    const h = 70 + r() * 190
    hills.setMatrixAt(i, new THREE.Matrix4().compose(
      new THREE.Vector3(cx + Math.sin(ang) * dist, base + h / 2 - 10, cz + Math.cos(ang) * dist),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 3, 0)),
      new THREE.Vector3(h * (0.7 + r() * 0.7), h, h * (0.7 + r() * 0.7)),
    ))
  }
  group.add(hills)
  disposables.push(hillGeo, hillMat)

  // --- コース脇の飾り ----------------------------------------------------------
  t.props.forEach((spec, si) => {
    const rand = rng(1000 + si * 97)
    const step = Math.max(1, Math.round(spec.every / c.spacing))
    const placements: THREE.Matrix4[] = []
    for (let i = 0; i < c.n; i += step) {
      if (c.kind[i] === CO.KIND_GAP) continue
      for (const side of [-1, 1]) {
        const o = side * (c.width[i] / 2 + spec.offset + rand() * spec.offset * 0.5)
        const p = edgePoint(c, i, o)
        // 高いところ（高架）の脇には置かない。空中に浮いて見えるため
        const y = t.terrain === 'follow' ? p[1] - 0.2 : base
        if (t.terrain === 'flat' && c.y[i] - base > 8 && spec.shape !== 'tower') continue
        const s = spec.scale * (1 + (rand() * 2 - 1) * spec.vary)
        placements.push(new THREE.Matrix4().compose(
          new THREE.Vector3(p[0], y, p[2]),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, 0)),
          new THREE.Vector3(s, s, s),
        ))
      }
    }
    if (!placements.length) return
    for (const part of propParts(spec)) {
      const inst = new THREE.InstancedMesh(part.geo, part.mat, placements.length)
      inst.castShadow = spec.shape !== 'tower'
      const m = new THREE.Matrix4()
      placements.forEach((pl, k) => inst.setMatrixAt(k, m.multiplyMatrices(pl, part.local)))
      group.add(inst)
      disposables.push(part.geo, part.mat)
    }
  })

  // --- 光 ---------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(t.sunColor, t.sunStrength)
  sun.position.set(...t.sunDir).multiplyScalar(260)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 20
  sun.shadow.camera.far = 700
  const span = 110
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span })
  sun.shadow.camera.updateProjectionMatrix()
  sun.shadow.bias = -0.0012
  group.add(sun)
  group.add(sun.target)
  group.add(new THREE.HemisphereLight(t.ambientColor, t.ground, t.ambientStrength))

  return {
    group, sun,
    dispose() { for (const d of disposables) d.dispose() },
  }
}
