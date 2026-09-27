// 通行人の 3D。人を 1 人ずつ Mesh にすると 120 人 × 20 部品 = 2400 回の描画命令になって重いので、
// 部品（太もも・すね・前腕…）ごとに InstancedMesh にして、全員ぶんを部品 1 種類 1 回で描く。
//
// 体の作り（高さ約 1.75m・頭身 7.5 の大人の比率）:
//   胴      ろくろ（Lathe）で「腰 → くびれ → 胸 → 肩」の起伏をつけ、前後に薄くつぶす
//   手足    上腕・前腕・太もも・すねを別々の部品にし、肩・肘・股・膝・足首で曲げる
//   頭      あご・鼻・耳をつけた頭。髪は短髪・長髪・帽子の 3 種類
//   服      長袖・半袖、ズボン・スカート。布はつや（sheen）のある素材
//
// 毎フレーム、人ごとに「体の位置・向き・倒れ具合」の行列を作り、関節の角度を順に掛けて
// 部品ごとの行列を入れ直す（骨格アニメーションを手で計算しているのと同じ）。

import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Ped } from '../sim/pedestrians'

const MAX = 320

// 寸法（m）。立っているときの関節の高さ
const HIP_Y = 0.93, HIP_X = 0.088
const THIGH = 0.44, SHIN = 0.43
const SHOULDER_Y = 1.43, SHOULDER_X = 0.185
const UPPER_ARM = 0.29, FOREARM = 0.26

type PartName = 'pelvis' | 'torso' | 'neck' | 'head' | 'face' | 'hairShort' | 'hairLong' | 'cap' | 'skirt'
  | 'thigh' | 'shin' | 'shoe' | 'upperArm' | 'forearm' | 'hand'

/** 上端を原点に、下へ伸びる回転体（手足）。profile は [半径, 上端からの距離] */
function limb(profile: [number, number][], seg = 10): THREE.BufferGeometry {
  const pts = profile.map(([r, d]) => new THREE.Vector2(r, -d))
  const g = new THREE.LatheGeometry(pts, seg)
  g.computeVertexNormals()
  return g
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
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
  // 同じ位置の頂点をつなぎ直して、なめらかな陰影にする（つながないと面ごとに角ばって見える）
  const m = mergeVertices(out, 1e-5)
  out.dispose()
  m.computeVertexNormals()
  void nor
  return m
}

/**
 * 顔の絵（512 × 512）。目は白目・虹彩・瞳・まぶたの影・まつげ、眉は毛の流れ、鼻は陰影、唇は上下で色を変える。
 * 顔の面（頭の前半分を覆う球の一部）に貼る。背景は透明なので、下の肌の色がそのまま見える
 */
function faceTexture(): THREE.CanvasTexture {
  const S = 512
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.clearRect(0, 0, S, S)
  // 頬と目のまわりの陰影（うっすら）
  const shade = (x: number, y: number, r: number, color: string) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    grd.addColorStop(0, color)
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  shade(170, 250, 60, 'rgba(60,20,10,0.16)')
  shade(342, 250, 60, 'rgba(60,20,10,0.16)')
  shade(160, 330, 70, 'rgba(200,60,60,0.10)')
  shade(352, 330, 70, 'rgba(200,60,60,0.10)')
  for (const ex of [185, 327]) {
    const ey = 250
    // 白目
    g.save()
    g.beginPath()
    g.ellipse(ex, ey, 38, 17, 0, 0, Math.PI * 2)
    g.clip()
    g.fillStyle = '#f2ece6'
    g.fillRect(ex - 40, ey - 20, 80, 40)
    // 虹彩と瞳
    const iris = g.createRadialGradient(ex, ey, 2, ex, ey, 16)
    iris.addColorStop(0, '#1a0f08')
    iris.addColorStop(0.35, '#24160c')
    iris.addColorStop(0.75, '#4a3020')
    iris.addColorStop(1, '#1a100a')
    g.fillStyle = iris
    g.beginPath()
    g.arc(ex, ey + 1, 16, 0, Math.PI * 2)
    g.fill()
    // 光の映り込み
    g.fillStyle = 'rgba(255,255,255,0.85)'
    g.beginPath()
    g.arc(ex - 5, ey - 5, 4, 0, Math.PI * 2)
    g.fill()
    // 上まぶたの影
    const lid = g.createLinearGradient(0, ey - 18, 0, ey)
    lid.addColorStop(0, 'rgba(40,20,10,0.55)')
    lid.addColorStop(1, 'rgba(40,20,10,0)')
    g.fillStyle = lid
    g.fillRect(ex - 40, ey - 20, 80, 20)
    g.restore()
    // まつげ（上まぶたの線）
    g.strokeStyle = '#1b120c'
    g.lineWidth = 5
    g.beginPath()
    g.ellipse(ex, ey, 39, 18, 0, Math.PI * 1.05, Math.PI * 1.95)
    g.stroke()
    // 下まぶたの影
    g.strokeStyle = 'rgba(80,40,30,0.35)'
    g.lineWidth = 2
    g.beginPath()
    g.ellipse(ex, ey + 1, 36, 16, 0, Math.PI * 0.15, Math.PI * 0.85)
    g.stroke()
    // 二重の線
    g.strokeStyle = 'rgba(60,30,20,0.35)'
    g.lineWidth = 2
    g.beginPath()
    g.ellipse(ex, ey - 6, 36, 18, 0, Math.PI * 1.15, Math.PI * 1.85)
    g.stroke()
  }
  // 眉（毛の流れを細い線で）
  for (const [ex, dir] of [[185, 1], [327, -1]] as const) {
    for (let k = 0; k < 60; k++) {
      const t = k / 60
      const x = ex - dir * 45 + dir * t * 95
      const y = 195 - Math.sin(t * Math.PI) * 12 + (Math.random() - 0.5) * 6
      g.strokeStyle = `rgba(35,22,14,${0.5 + Math.random() * 0.4})`
      g.lineWidth = 2 + (1 - t) * 2.5
      g.beginPath()
      g.moveTo(x, y + 6)
      g.lineTo(x + dir * 9, y - 2)
      g.stroke()
    }
  }
  // 鼻（影と鼻の穴）
  shade(256, 300, 40, 'rgba(90,40,25,0.18)')
  g.fillStyle = 'rgba(60,25,15,0.55)'
  for (const nx of [240, 272]) {
    g.beginPath()
    g.ellipse(nx, 335, 8, 5, 0, 0, Math.PI * 2)
    g.fill()
  }
  g.strokeStyle = 'rgba(90,40,25,0.3)'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(228, 330); g.quadraticCurveTo(256, 348, 284, 330)
  g.stroke()
  // 唇
  const lipTop = g.createLinearGradient(0, 385, 0, 400)
  lipTop.addColorStop(0, '#9a4a44')
  lipTop.addColorStop(1, '#7a3432')
  g.fillStyle = lipTop
  g.beginPath()
  g.moveTo(205, 400)
  g.quadraticCurveTo(235, 380, 256, 388)
  g.quadraticCurveTo(277, 380, 307, 400)
  g.quadraticCurveTo(256, 404, 205, 400)
  g.fill()
  const lipBot = g.createLinearGradient(0, 400, 0, 425)
  lipBot.addColorStop(0, '#8e403c')
  lipBot.addColorStop(1, '#b0605a')
  g.fillStyle = lipBot
  g.beginPath()
  g.moveTo(208, 401)
  g.quadraticCurveTo(256, 432, 304, 401)
  g.quadraticCurveTo(256, 408, 208, 401)
  g.fill()
  g.strokeStyle = 'rgba(50,15,12,0.7)'
  g.lineWidth = 2.5
  g.beginPath()
  g.moveTo(205, 400); g.quadraticCurveTo(256, 408, 307, 400)
  g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function buildGeometries(): Record<PartName, THREE.BufferGeometry> {
  // 胴: 腰（0.95）から肩（1.47）まで。くびれと胸のふくらみ、なで肩
  const torso = new THREE.LatheGeometry([
    [0.001, 0.93], [0.125, 0.94], [0.132, 1.0], [0.122, 1.08], [0.13, 1.18], [0.148, 1.29], [0.152, 1.36],
    [0.14, 1.42], [0.1, 1.47], [0.055, 1.5], [0.001, 1.505],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 14)
  torso.scale(1.28, 1, 0.78)
  torso.computeVertexNormals()
  const pelvis = new THREE.LatheGeometry([
    [0.001, 0.84], [0.1, 0.845], [0.135, 0.88], [0.14, 0.95], [0.001, 0.955],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 14)
  pelvis.scale(1.2, 1, 0.82)
  pelvis.computeVertexNormals()
  const neck = new THREE.CylinderGeometry(0.043, 0.05, 0.12, 10).translate(0, 1.53, 0.005)

  // 頭: 少し縦長の球に、あご・鼻・耳
  const skull = new THREE.SphereGeometry(0.1, 20, 16).scale(0.92, 1.12, 1.02).translate(0, 1.665, 0)
  const jaw = new THREE.SphereGeometry(0.07, 14, 10).scale(1.05, 0.85, 1).translate(0, 1.6, 0.025)
  const nose = new THREE.ConeGeometry(0.016, 0.045, 6).rotateX(Math.PI / 2).translate(0, 1.655, 0.108)
  const earL = new THREE.SphereGeometry(0.022, 8, 6).scale(0.5, 1, 0.8).translate(0.092, 1.66, 0)
  const earR = earL.clone().translate(-0.184, 0, 0)
  const head = merge([skull, jaw, nose, earL, earR])
  // 顔の面: 頭の前半分（眉から あごまで）を少しだけ大きな球の一部で覆い、顔の絵を貼る
  const face = new THREE.SphereGeometry(0.1015, 32, 24, Math.PI / 2 - 0.95, 1.9, 0.62, 1.55)
    .scale(0.92, 1.12, 1.02).translate(0, 1.665, 0.004)

  const hairShort = new THREE.SphereGeometry(0.106, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52)
    .scale(0.95, 1.12, 1.08).translate(0, 1.672, -0.008)
  const hairLong = merge([
    new THREE.SphereGeometry(0.108, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.97, 1.14, 1.1).translate(0, 1.672, -0.01),
    new THREE.CylinderGeometry(0.1, 0.085, 0.24, 14, 1, true, Math.PI * 0.62, Math.PI * 1.76).translate(0, 1.56, -0.015),
  ])
  const cap = merge([
    new THREE.SphereGeometry(0.108, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.97, 0.9, 1.08).translate(0, 1.69, -0.005),
    new THREE.CylinderGeometry(0.075, 0.075, 0.012, 16).scale(1, 1, 1.1).translate(0, 1.695, 0.1),
  ])
  const skirt = new THREE.CylinderGeometry(0.15, 0.24, 0.42, 16, 1, true).scale(1.15, 1, 0.9).translate(0, 0.72, 0)

  const thigh = limb([[0.001, -0.02], [0.07, 0], [0.078, 0.08], [0.07, 0.25], [0.056, 0.42], [0.05, THIGH], [0.001, THIGH + 0.02]])
  const shin = limb([[0.001, -0.01], [0.05, 0.01], [0.053, 0.1], [0.047, 0.2], [0.035, 0.38], [0.032, SHIN], [0.001, SHIN + 0.01]])
  // 靴: 足首から前へ伸びる、角の丸い形
  const shoe = merge([
    new THREE.BoxGeometry(0.092, 0.07, 0.24, 1, 1, 2).translate(0, -0.045, 0.045),
    new THREE.SphereGeometry(0.05, 10, 8).scale(0.95, 0.7, 1.2).translate(0, -0.045, 0.15),
  ])
  const upperArm = limb([[0.001, -0.02], [0.046, 0], [0.047, 0.06], [0.04, 0.2], [0.035, UPPER_ARM], [0.001, UPPER_ARM + 0.01]])
  const forearm = limb([[0.001, -0.01], [0.036, 0.005], [0.038, 0.06], [0.028, 0.24], [0.026, FOREARM], [0.001, FOREARM + 0.01]])
  const hand = new THREE.SphereGeometry(0.04, 10, 8).scale(0.62, 1.25, 0.9).translate(0, -0.045, 0)

  return { pelvis, torso, neck, head, face, hairShort, hairLong, cap, skirt, thigh, shin, shoe, upperArm, forearm, hand }
}

const DOUBLE: PartName[] = ['thigh', 'shin', 'shoe', 'upperArm', 'forearm', 'hand']

export class PedModels {
  readonly group = new THREE.Group()
  private meshes: Record<PartName, THREE.InstancedMesh>
  private pools: THREE.InstancedMesh
  private root = new THREE.Matrix4()
  private tmp = new THREE.Matrix4()
  private a = new THREE.Matrix4()
  private b = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private qy = new THREE.Quaternion()
  private e = new THREE.Euler()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3()
  private one = new THREE.Vector3(1, 1, 1)
  private zero = new THREE.Matrix4().makeScale(0, 0, 0)
  private c = new THREE.Color()
  private colored = new Map<number, number>()
  private axis = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)

  constructor() {
    const geos = buildGeometries()
    // 布: 表面の毛羽立ちで縁が明るく見える sheen を使うと、服らしく見える
    const cloth = new THREE.MeshPhysicalMaterial({ roughness: 0.92, sheen: 1, sheenRoughness: 0.7, sheenColor: 0x555555 })
    const skin = new THREE.MeshPhysicalMaterial({ roughness: 0.55, sheen: 0.4, sheenRoughness: 0.4, sheenColor: 0x442211 })
    const hair = new THREE.MeshStandardMaterial({ roughness: 0.75 })
    const shoe = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 })
    const faceMat = new THREE.MeshStandardMaterial({
      map: faceTexture(), transparent: true, alphaTest: 0.02, roughness: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1,
    })
    const mat: Record<PartName, THREE.Material> = {
      face: faceMat,
      pelvis: cloth, torso: cloth, neck: skin, head: skin, hairShort: hair, hairLong: hair, cap: cloth, skirt: cloth,
      thigh: cloth, shin: cloth, shoe, upperArm: cloth, forearm: cloth, hand: skin,
    }
    const meshes = {} as Record<PartName, THREE.InstancedMesh>
    for (const name of Object.keys(geos) as PartName[]) {
      const im = new THREE.InstancedMesh(geos[name], mat[name], DOUBLE.includes(name) ? MAX * 2 : MAX)
      im.castShadow = name !== 'hand' && name !== 'neck' && name !== 'face'
      im.receiveShadow = true
      im.count = 0
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      if (name === 'skirt') (im.material as THREE.Material).side = THREE.DoubleSide
      this.group.add(im)
      meshes[name] = im
    }
    this.meshes = meshes
    // 倒れた人の下の暗い染み（控えめに）
    const poolMat = new THREE.MeshStandardMaterial({
      color: 0x2a0404, roughness: 0.1, transparent: true, opacity: 0.8, polygonOffset: true, polygonOffsetFactor: -3,
    })
    this.pools = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), poolMat, MAX)
    this.pools.count = 0
    this.pools.frustumCulled = false
    this.group.add(this.pools)
  }

  /** 関節: 位置 (x, y, z) に置いて、x 軸（前後の振り）・z 軸（横に開く）の順に回す */
  private joint(out: THREE.Matrix4, x: number, y: number, z: number, rx: number, rz = 0, ry = 0): THREE.Matrix4 {
    this.e.set(rx, ry, rz, 'YZX')
    this.q.setFromEuler(this.e)
    return out.compose(this.v.set(x, y, z), this.q, this.one)
  }

  private put(part: PartName, i: number, local: THREE.Matrix4): void {
    this.tmp.multiplyMatrices(this.root, local)
    this.meshes[part].setMatrixAt(i, this.tmp)
  }

  private hide(part: PartName, i: number): void {
    this.meshes[part].setMatrixAt(i, this.zero)
  }

  update(peds: Ped[], time: number, groundY: (x: number, z: number) => number): void {
    const n = Math.min(peds.length, MAX)
    let pools = 0
    for (let i = 0; i < n; i++) {
      const p = peds[i]
      const L = p.look
      // --- 体全体: 位置 → 倒れる（倒れる向きの横を軸に回す） → 向き -------------------
      const fy = p.fallYaw
      this.axis.set(Math.cos(fy), 0, -Math.sin(fy))
      const lying = Math.abs(Math.sin(p.tilt))
      const y = (p.mode === 'fly' ? p.y : 0) + groundY(p.x, p.z) + lying * 0.12
      this.q.setFromAxisAngle(this.axis, p.tilt)
      this.qy.setFromAxisAngle(this.up, p.yaw)
      this.q.multiply(this.qy)
      this.root.compose(this.v.set(p.x, y, p.z), this.q, this.s.set(L.width, L.height, L.width))

      // --- 動きの種類ごとの関節の角度 ---------------------------------------------------
      const walkingOfficer = p.mode === 'officer' && Math.hypot(p.tx - p.x, p.tz - p.z) > 0.25
      const running = p.mode === 'flee' || (walkingOfficer && p.officer!.run)
      const moving = p.mode === 'walk' || p.mode === 'cross' || p.mode === 'return' || running || walkingOfficer
      const down = p.mode === 'down' || p.mode === 'stagger'
      const flying = p.mode === 'fly'
      const A = moving ? (running ? 0.85 : 0.42) : 0 // 脚の振りの大きさ
      const ph = p.phase
      const lean = running ? 0.22 : 0.03
      const bob = moving ? Math.abs(Math.cos(ph)) * (running ? 0.05 : 0.022) - (running ? 0.04 : 0.01) : 0
      const breathe = Math.sin(time * 1.8 + p.id) * 0.006
      const sway = moving ? Math.sin(ph) * (running ? 0.12 : 0.08) : Math.sin(time * 0.7 + p.id) * 0.03
      const flail = flying ? time * 11 + p.id : 0

      this.put('pelvis', i, this.joint(this.a, 0, bob, 0, 0, 0, sway * 0.6))
      // 胴は腰を軸に前傾し、腰と逆にひねる（歩くときの自然なねじれ）
      const torsoM = this.joint(this.b, 0, 0.95 + bob, 0, lean + breathe, flying ? Math.sin(flail) * 0.4 : 0, -sway)
      torsoM.multiply(this.a.makeTranslation(0, -0.95, 0))
      this.put('torso', i, torsoM)
      const torsoTop = torsoM.clone()
      this.put('neck', i, torsoTop)
      // 頭: 少し前を見る。倒れているときは横を向く
      const headM = torsoTop.clone().multiply(this.joint(this.a, 0, 1.52, 0, running ? -0.2 : -0.04, 0, down ? 0.9 : Math.sin(time * 0.4 + p.id * 3) * 0.25))
        .multiply(this.b.makeTranslation(0, -1.52, 0))
      this.put('head', i, headM)
      this.put('face', i, headM)
      const style = L.hairStyle
      if (style === 0) this.put('hairShort', i, headM); else this.hide('hairShort', i)
      if (style === 1) this.put('hairLong', i, headM); else this.hide('hairLong', i)
      if (style === 2) this.put('cap', i, headM); else this.hide('cap', i)
      const skirt = L.skirt
      if (skirt) this.put('skirt', i, this.joint(this.a, 0, bob, 0, 0, 0, sway * 0.6)); else this.hide('skirt', i)

      for (const side of [1, -1]) {
        const k = i * 2 + (side > 0 ? 0 : 1)
        const ps = side > 0 ? ph : ph + Math.PI // 左右の脚は半周期ずれる
        // 脚: 前へ振るのは x 軸まわりに負の角度。膝は脚を前へ振り出す途中で大きく曲がる
        let hip = -A * Math.sin(ps)
        let knee = moving ? 0.08 + A * 1.25 * Math.max(0, Math.cos(ps - 0.5)) : 0.04
        let hipOut = 0
        let ankle = 0
        if (down) { hip = -0.15 - side * 0.1; knee = 0.25 + (side > 0 ? 0.5 : 0.1); hipOut = side * 0.2 }
        if (flying) { hip = Math.sin(flail + side) * 0.9; knee = 0.6 + Math.sin(flail * 1.3 + side) * 0.5; hipOut = side * 0.25 }
        ankle = -knee * 0.35 + (moving ? A * 0.3 * Math.sin(ps + 1) : 0)
        const thighM = this.joint(this.a, side * HIP_X, HIP_Y + bob, 0, hip, hipOut, 0).clone()
        this.tmp.multiplyMatrices(this.root, thighM)
        this.meshes.thigh.setMatrixAt(k, this.tmp)
        const shinM = thighM.clone().multiply(this.joint(this.b, 0, -THIGH, 0, knee))
        this.tmp.multiplyMatrices(this.root, shinM)
        this.meshes.shin.setMatrixAt(k, this.tmp)
        const shoeM = shinM.multiply(this.joint(this.b, 0, -SHIN, 0, ankle))
        this.tmp.multiplyMatrices(this.root, shoeM)
        this.meshes.shoe.setMatrixAt(k, this.tmp)

        // 腕: 脚と逆に振る。肘は走ると大きく曲がる
        let shoulder = A * 0.75 * Math.sin(ps) - (running ? 0.2 : 0)
        let elbow = -(running ? 1.45 : 0.22 + A * 0.25 * Math.max(0, -Math.sin(ps)))
        let armOut = side * 0.09
        if (down) { shoulder = -0.3 - side * 0.3; elbow = -0.4; armOut = side * 1.3 }
        if (flying) { shoulder = Math.sin(flail * 1.2 + side * 2) * 1.6; elbow = -0.6; armOut = side * (0.9 + Math.sin(flail) * 0.5) }
        const upperM = torsoM.clone().multiply(this.joint(this.a, side * SHOULDER_X, SHOULDER_Y, 0.0, shoulder, armOut))
        this.tmp.multiplyMatrices(this.root, upperM)
        this.meshes.upperArm.setMatrixAt(k, this.tmp)
        const foreM = upperM.multiply(this.joint(this.b, 0, -UPPER_ARM, 0, elbow))
        this.tmp.multiplyMatrices(this.root, foreM)
        this.meshes.forearm.setMatrixAt(k, this.tmp)
        const handM = foreM.multiply(this.joint(this.b, 0, -FOREARM, 0, 0))
        this.tmp.multiplyMatrices(this.root, handM)
        this.meshes.hand.setMatrixAt(k, this.tmp)
      }

      // 色は人が入れ替わったときだけ塗り直す
      if (this.colored.get(i) !== p.id) {
        this.colored.set(i, p.id)
        const pants = L.skirt ? L.skin : L.pants
        this.setColor('pelvis', i, L.skirt ? L.shirt : L.pants)
        this.setColor('torso', i, L.shirt)
        this.setColor('neck', i, L.skin)
        this.setColor('head', i, L.skin)
        this.setColor('hairShort', i, L.hair)
        this.setColor('hairLong', i, L.hair)
        this.setColor('cap', i, L.pants)
        this.setColor('skirt', i, L.pants)
        for (const k of [i * 2, i * 2 + 1]) {
          this.setColor('thigh', k, pants)
          this.setColor('shin', k, pants)
          this.setColor('shoe', k, L.shoes)
          this.setColor('upperArm', k, L.shirt)
          this.setColor('forearm', k, L.shortSleeve ? L.skin : L.shirt)
          this.setColor('hand', k, L.skin)
        }
      }

      if (p.mode === 'down') {
        const r = Math.min(0.2 + p.downTime * 0.1, 0.85)
        this.tmp.compose(this.v.set(p.x + Math.sin(fy) * 0.5, groundY(p.x, p.z) + 0.015, p.z + Math.cos(fy) * 0.5),
                         this.q.identity(), this.s.set(r, 1, r * 0.8))
        this.pools.setMatrixAt(pools++, this.tmp)
      }
    }
    for (const part of Object.keys(this.meshes) as PartName[]) {
      const im = this.meshes[part]
      im.count = DOUBLE.includes(part) ? n * 2 : n
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    }
    this.pools.count = pools
    this.pools.instanceMatrix.needsUpdate = true
  }

  private setColor(part: PartName, i: number, color: number): void {
    this.meshes[part].setColorAt(i, this.c.setHex(color))
  }

  dispose(): void {
    const mats = new Set<THREE.Material>()
    for (const im of [...Object.values(this.meshes), this.pools]) {
      im.geometry.dispose()
      mats.add(im.material as THREE.Material)
      im.dispose()
    }
    for (const m of mats) m.dispose()
  }
}
