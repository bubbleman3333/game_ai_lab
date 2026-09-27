// 海の生き物と真珠の見た目。動きの決まり（どこにいるか）は sim/game.ts で、ここは絵だけ。
//
//   クラゲ  半球の傘 + 垂れた触手。傘がふくらんだり縮んだりする（拍動）
//   サメ    回転体（Lathe）の胴体に、背びれ・胸びれ・尾びれ・あご。尾を振り、突っ込むときは口を開ける
//   真珠    光る玉と、まわりのぼんやりした光
//   魚の群れ InstancedMesh で 1 回の描画。群れの中心のまわりを楕円に泳ぐ（見た目だけ）

import * as THREE from 'three'

const disposeAll = (items: { dispose(): void }[]) => { for (const d of items) d.dispose() }

// --- クラゲ -------------------------------------------------------------------
const JELLY_COLORS = [0xff7ad9, 0x9d7bff, 0x5fe3ff]

interface JellyShared {
  bell: THREE.BufferGeometry
  core: THREE.BufferGeometry
  tentacle: THREE.BufferGeometry
  arm: THREE.BufferGeometry
  bellMats: THREE.MeshPhysicalMaterial[]
  coreMats: THREE.MeshBasicMaterial[]
  tentMats: THREE.MeshStandardMaterial[]
  /** まわりのぼんやりした光（夜に目立つ） */
  haloMats: THREE.SpriteMaterial[]
}

let jellyShared: JellyShared | null = null

function getJellyShared(): JellyShared {
  if (jellyShared) return jellyShared
  const bell = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.58)
  const core = new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6)
  const tentacle = new THREE.CylinderGeometry(0.012, 0.03, 2.0, 5, 1, true)
  tentacle.translate(0, -1.0, 0)
  const arm = new THREE.CylinderGeometry(0.03, 0.09, 1.3, 6, 1, true)
  arm.translate(0, -0.65, 0)
  const bellMats = JELLY_COLORS.map((c) => new THREE.MeshPhysicalMaterial({
    color: c, emissive: c, emissiveIntensity: 0.35, transparent: true, opacity: 0.5,
    roughness: 0.25, side: THREE.DoubleSide, depthWrite: false,
  }))
  const coreMats = JELLY_COLORS.map((c) => new THREE.MeshBasicMaterial({
    color: new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.15), transparent: true, opacity: 0.6, depthWrite: false,
  }))
  const tentMats = JELLY_COLORS.map((c) => new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity: 0.4, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
  }))
  const halo = haloTexture()
  const haloMats = JELLY_COLORS.map((c) => new THREE.SpriteMaterial({
    map: halo, color: c, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
  }))
  jellyShared = { bell, core, tentacle, arm, bellMats, coreMats, tentMats, haloMats }
  return jellyShared
}

/** クラゲの光り方をまとめて変える（夜の区間で強く） */
export function setJellyGlow(intensity: number): void {
  const s = getJellyShared()
  // 明るくしすぎるとトーンマッピングで白く飛ぶので、傘は控えめにして色の輪（halo）で光らせる
  for (const m of s.bellMats) m.emissiveIntensity = Math.min(1.2, intensity)
  for (const m of s.tentMats) m.emissiveIntensity = Math.min(1.0, intensity * 0.7)
  for (const m of s.haloMats) m.opacity = Math.min(0.95, 0.12 + intensity * 0.35)
}

export interface JellyModel {
  group: THREE.Group
  update(t: number, phase: number): void
  dispose(): void
}

export function buildJelly(kind: number, size: number): JellyModel {
  const s = getJellyShared()
  const k = ((kind % JELLY_COLORS.length) + JELLY_COLORS.length) % JELLY_COLORS.length
  const group = new THREE.Group()
  const bell = new THREE.Mesh(s.bell, s.bellMats[k])
  bell.renderOrder = 5
  group.add(bell)
  const core = new THREE.Mesh(s.core, s.coreMats[k])
  core.position.y = -0.1
  core.renderOrder = 4
  group.add(core)
  const tentacles = new THREE.Group()
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const t = new THREE.Mesh(s.tentacle, s.tentMats[k])
    t.position.set(Math.cos(a) * 0.7, 0.05, Math.sin(a) * 0.7)
    t.rotation.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3)
    t.renderOrder = 4
    tentacles.add(t)
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4
    const t = new THREE.Mesh(s.arm, s.tentMats[k])
    t.position.set(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2)
    t.renderOrder = 4
    tentacles.add(t)
  }
  group.add(tentacles)
  const halo = new THREE.Sprite(s.haloMats[k])
  halo.scale.setScalar(4.0)
  halo.position.y = -0.3
  group.add(halo)
  group.scale.setScalar(size)
  return {
    group,
    update(t, phase) {
      // 拍動: 縮むときは縦に伸び、ふくらむときは横に広がる
      const p = Math.sin(t * 1.7 + phase)
      const sq = 1 + p * 0.13
      bell.scale.set(sq, 1 - p * 0.2, sq)
      halo.scale.setScalar(3.8 + p * 0.5)
      core.scale.setScalar(1 - p * 0.1)
      tentacles.scale.set(1 - p * 0.08, 1 + p * 0.06, 1 - p * 0.08)
      tentacles.rotation.y = t * 0.15
      group.rotation.z = Math.sin(t * 0.6 + phase) * 0.12
      group.rotation.x = Math.cos(t * 0.5 + phase) * 0.1
    },
    dispose() { /* 形と材質は共有なので消さない */ },
  }
}

// --- サメ ---------------------------------------------------------------------
export interface SharkModel {
  group: THREE.Group
  /** 背びれの位置（ワールド座標）。海面に出ているときの波しぶきに使う */
  finWorld(target: THREE.Vector3): THREE.Vector3
  update(dt: number, speed: number, charging: boolean): void
  dispose(): void
}

const SHARK_LEN = 4.6

/** 平たいひれ。shape は (前後, 上下) の面で描き、厚みは横（x）方向 */
function verticalFin(points: [number, number][], mat: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1])
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 })
  geo.rotateY(-Math.PI / 2) // shape の x → ワールドの z（前）、厚み → x
  geo.translate(0.04, 0, 0)
  return new THREE.Mesh(geo, mat)
}

/** 水平のひれ（胸びれ）。shape は (横, 前後) の面で描く */
function flatFin(points: [number, number][], mat: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape()
  shape.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1])
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 })
  geo.rotateX(Math.PI / 2) // shape の y → ワールドの z（前）、厚み → 上下
  return new THREE.Mesh(geo, mat)
}

export function buildShark(): SharkModel {
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []

  // 胴体: 尾（z=0）から鼻先（z=SHARK_LEN）までの太さの変化を回転体にする
  const profile: [number, number][] = [
    [0.06, 0], [0.14, 0.5], [0.3, 1.2], [0.48, 2.0], [0.6, 2.7], [0.62, 3.2],
    [0.55, 3.7], [0.42, 4.1], [0.25, 4.4], [0.0, SHARK_LEN],
  ]
  const bodyGeo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 20)
  bodyGeo.rotateX(Math.PI / 2) // y → z
  bodyGeo.translate(0, 0, -SHARK_LEN / 2)
  bodyGeo.computeVertexNormals()
  // 背中は灰青、腹は白（上下の位置で色を混ぜる）
  const pos = bodyGeo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const top = new THREE.Color(0x4a5e73), belly = new THREE.Color(0xe8ecef), c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const t = THREE.MathUtils.smoothstep(y, -0.25, 0.15)
    c.copy(belly).lerp(top, t)
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
  }
  bodyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 })
  const body = new THREE.Mesh(bodyGeo, bodyMat)
  body.scale.set(0.82, 1, 1) // 横に少し細く
  group.add(body)
  disposables.push(bodyGeo, bodyMat)

  const finMat = new THREE.MeshStandardMaterial({ color: 0x435568, roughness: 0.6 })
  disposables.push(finMat)
  const track = (m: THREE.Mesh) => { disposables.push(m.geometry); return m }

  // 背びれ（後ろへ反った三角）
  const dorsal = track(verticalFin([[-0.55, 0.0], [0.5, 0.0], [0.05, 1.05], [-0.25, 1.0]], finMat))
  dorsal.position.set(0, 0.45, 0.35)
  group.add(dorsal)
  // 胸びれ（左右）
  for (const side of [-1, 1]) {
    const fin = track(flatFin([[0, 0.3], [side * 1.3, -0.5], [side * 1.05, -0.75], [0, -0.35]], finMat))
    fin.position.set(side * 0.35, -0.25, 0.85)
    fin.rotation.z = side * 0.35 // 少し下向きに開く
    group.add(fin)
  }
  // 小さな第二背びれと尻びれ
  const dorsal2 = track(verticalFin([[-0.2, 0], [0.2, 0], [0.0, 0.32]], finMat))
  dorsal2.position.set(0, 0.28, -1.35)
  group.add(dorsal2)
  // 尾びれ（縦に大きく、上の葉が長い）。尾の付け根を軸に振る
  const tail = new THREE.Group()
  tail.position.set(0, 0, -SHARK_LEN / 2 + 0.55)
  const tailFin = track(verticalFin([[0.1, 0.1], [-0.9, 1.25], [-1.05, 1.15], [-0.45, 0.05], [-0.75, -0.7], [-0.6, -0.78], [0.1, -0.1]], finMat))
  tailFin.position.z = -0.4
  tail.add(tailFin)
  group.add(tail)

  // 目
  const eyeGeo = new THREE.SphereGeometry(0.07, 8, 6)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.2 })
  disposables.push(eyeGeo, eyeMat)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat)
    eye.position.set(side * 0.3, 0.1, 1.55)
    group.add(eye)
  }
  // えら（5 本の細い線）
  const gillGeo = new THREE.BoxGeometry(0.02, 0.3, 0.04)
  const gillMat = new THREE.MeshStandardMaterial({ color: 0x2b3a4a })
  disposables.push(gillGeo, gillMat)
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Mesh(gillGeo, gillMat)
      g.position.set(side * 0.5, 0.05, 1.05 - i * 0.12)
      g.rotation.z = side * 0.15
      group.add(g)
    }
  }
  // あご（付け根を軸に開く）と歯
  const jaw = new THREE.Group()
  jaw.position.set(0, -0.22, 1.35)
  const jawMat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.6 })
  const jawGeo = new THREE.BoxGeometry(0.5, 0.1, 0.7)
  disposables.push(jawMat, jawGeo)
  const jawMesh = new THREE.Mesh(jawGeo, jawMat)
  jawMesh.position.z = 0.3
  jaw.add(jawMesh)
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x7a1f2a, roughness: 0.9 })
  const mouthGeo = new THREE.BoxGeometry(0.46, 0.04, 0.6)
  disposables.push(mouthMat, mouthGeo)
  const mouth = new THREE.Mesh(mouthGeo, mouthMat)
  mouth.position.set(0, 0.06, 0.3)
  jaw.add(mouth)
  const toothGeo = new THREE.ConeGeometry(0.03, 0.1, 5)
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xffffff })
  disposables.push(toothGeo, toothMat)
  for (let i = 0; i < 7; i++) {
    for (const side of [-1, 1]) {
      const t = new THREE.Mesh(toothGeo, toothMat)
      t.position.set(side * (0.22 - i * 0.02), 0.1, 0.62 - i * 0.08)
      jaw.add(t)
    }
  }
  group.add(jaw)

  let wag = 0
  let jawOpen = 0
  const finTmp = new THREE.Vector3()

  return {
    group,
    finWorld(target) {
      finTmp.set(0, 1.4, 0.35)
      return group.localToWorld(target.copy(finTmp))
    },
    update(dt, speed, charging) {
      wag += (2.5 + speed * 0.55) * dt
      tail.rotation.y = Math.sin(wag) * (0.35 + Math.min(speed, 12) * 0.02)
      body.rotation.y = Math.sin(wag - 0.6) * 0.03
      jawOpen = THREE.MathUtils.damp(jawOpen, charging ? 1 : 0, 8, dt)
      jaw.rotation.x = jawOpen * 0.55
    },
    dispose() { disposeAll(disposables) },
  }
}

// --- 真珠 ---------------------------------------------------------------------
let pearlGeo: THREE.SphereGeometry | null = null
let pearlMat: THREE.MeshStandardMaterial | null = null
let haloMat: THREE.SpriteMaterial | null = null

function haloTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,0.9)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.35)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export interface PearlModel {
  group: THREE.Group
  update(t: number, phase: number): void
  dispose(): void
}

export function buildPearl(): PearlModel {
  pearlGeo ??= new THREE.SphereGeometry(0.3, 16, 12)
  pearlMat ??= new THREE.MeshStandardMaterial({ color: 0xfff4dc, emissive: 0xffd88a, emissiveIntensity: 0.8, roughness: 0.15, metalness: 0.2 })
  haloMat ??= new THREE.SpriteMaterial({ map: haloTexture(), color: 0xffe2a0, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
  const group = new THREE.Group()
  const ball = new THREE.Mesh(pearlGeo, pearlMat)
  group.add(ball)
  const halo = new THREE.Sprite(haloMat)
  halo.scale.setScalar(2.2)
  group.add(halo)
  return {
    group,
    update(t, phase) {
      ball.position.y = Math.sin(t * 2 + phase) * 0.15
      ball.rotation.y = t
      halo.scale.setScalar(2.0 + Math.sin(t * 3 + phase) * 0.3)
    },
    dispose() { /* 共有 */ },
  }
}

// --- 魚の群れ -----------------------------------------------------------------
const SCHOOLS = 4
const FISH_PER_SCHOOL = 36

interface School {
  cx: number
  cy: number
  cz: number
  rx: number
  rz: number
  speed: number
  color: THREE.Color
}

export class FishSchools {
  readonly mesh: THREE.InstancedMesh
  private schools: School[] = []
  private phases: Float32Array
  private geo: THREE.BufferGeometry
  private mat: THREE.MeshStandardMaterial
  private dummy = new THREE.Object3D()
  private tmp = new THREE.Vector3()

  constructor() {
    this.geo = new THREE.SphereGeometry(0.12, 7, 5)
    this.geo.scale(0.45, 0.7, 2.2)
    this.mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 })
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, SCHOOLS * FISH_PER_SCHOOL)
    this.mesh.frustumCulled = false
    this.phases = new Float32Array(SCHOOLS * FISH_PER_SCHOOL)
    for (let i = 0; i < this.phases.length; i++) this.phases[i] = Math.random() * Math.PI * 2
    const palette = [0xc0c8d0, 0xf0a040, 0x60c0ff, 0xffe070]
    for (let s = 0; s < SCHOOLS; s++) {
      this.schools.push({ cx: 0, cy: -3, cz: -100, rx: 3, rz: 5, speed: 0.6, color: new THREE.Color(palette[s % palette.length]) })
      for (let i = 0; i < FISH_PER_SCHOOL; i++) this.mesh.setColorAt(s * FISH_PER_SCHOOL + i, this.schools[s].color)
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** 群れを泳ぐ人の前方に置き直す（後ろに流れたとき） */
  private respawn(s: School, playerX: number, playerZ: number): void {
    s.cx = playerX + (Math.random() - 0.5) * 40
    s.cy = -2 - Math.random() * 6
    s.cz = playerZ + 40 + Math.random() * 60
    s.rx = 2 + Math.random() * 3
    s.rz = 3 + Math.random() * 4
    s.speed = 0.4 + Math.random() * 0.5
  }

  update(t: number, playerX: number, playerZ: number, floorY: number): void {
    const d = this.dummy
    this.schools.forEach((s, si) => {
      if (s.cz < playerZ - 25) this.respawn(s, playerX, playerZ)
      // 群れ全体もゆっくり漂う
      s.cx += Math.sin(t * 0.3 + si) * 0.02
      const cy = Math.max(s.cy, floorY + 1.5)
      for (let i = 0; i < FISH_PER_SCHOOL; i++) {
        const idx = si * FISH_PER_SCHOOL + i
        const ph = this.phases[idx]
        const a = t * s.speed + ph
        const x = s.cx + Math.cos(a) * s.rx * (0.6 + 0.4 * Math.sin(ph * 3))
        const y = cy + Math.sin(a * 2 + ph) * 0.6
        const z = s.cz + Math.sin(a) * s.rz * (0.6 + 0.4 * Math.cos(ph * 2))
        // 進む向き（少し先の位置との差）
        const a2 = a + 0.1
        this.tmp.set(
          s.cx + Math.cos(a2) * s.rx * (0.6 + 0.4 * Math.sin(ph * 3)),
          cy + Math.sin(a2 * 2 + ph) * 0.6,
          s.cz + Math.sin(a2) * s.rz * (0.6 + 0.4 * Math.cos(ph * 2)),
        )
        d.position.set(x, y, z)
        d.lookAt(this.tmp)
        d.updateMatrix()
        this.mesh.setMatrixAt(idx, d.matrix)
      }
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
    this.mesh.dispose()
  }
}

/** 共有している形と材質を消す（場面を閉じるとき） */
export function disposeShared(): void {
  if (jellyShared) {
    jellyShared.haloMats[0].map?.dispose()
    disposeAll([jellyShared.bell, jellyShared.core, jellyShared.tentacle, jellyShared.arm,
                ...jellyShared.bellMats, ...jellyShared.coreMats, ...jellyShared.tentMats, ...jellyShared.haloMats])
    jellyShared = null
  }
  pearlGeo?.dispose(); pearlGeo = null
  pearlMat?.dispose(); pearlMat = null
  haloMat?.map?.dispose(); haloMat?.dispose(); haloMat = null
}
