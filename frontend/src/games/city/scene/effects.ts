// 煙・火・火花・爆発の粒子、タイヤ痕、雨と雪。
//
// 粒子は THREE.Points 1 つに全部入れて、自前の小さなシェーダーで「大きさ・色・透明度」を粒ごとに変える。
// 足し算で光る粒（火・火花）と、ふつうに重なる粒（煙・砂ぼこり）は混ぜ方が違うので 2 組に分けている。

import * as THREE from 'three'
import * as TX from './textures'

const VERT = /* glsl */ `
  attribute float size;
  attribute vec4 tint;
  varying vec4 vTint;
  uniform float scale;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`
const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec4 vTint;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vTint.rgb, vTint.a * t.a);
    if (gl_FragColor.a < 0.004) discard;
  }
`

interface P {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life: number; max: number
  size0: number; size1: number
  r: number; g: number; b: number
  a: number
  /** 上へ昇る力（煙）・重力（火花） */
  lift: number
  drag: number
}

class ParticlePool {
  readonly points: THREE.Points
  private list: P[] = []
  private pos: Float32Array
  private size: Float32Array
  private tint: Float32Array
  private geo: THREE.BufferGeometry
  readonly mat: THREE.ShaderMaterial
  private max: number

  constructor(max: number, additive: boolean, tex: THREE.Texture) {
    this.max = max
    this.geo = new THREE.BufferGeometry()
    this.pos = new Float32Array(max * 3)
    this.size = new Float32Array(max)
    this.tint = new Float32Array(max * 4)
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    this.geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage))
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 600 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    })
    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
  }

  emit(p: P): void {
    if (this.list.length >= this.max) this.list.shift()
    this.list.push(p)
  }

  update(dt: number): void {
    const L = this.list
    for (let k = L.length - 1; k >= 0; k--) {
      const p = L[k]
      p.life += dt
      if (p.life >= p.max) { L.splice(k, 1); continue }
      const d = Math.exp(-p.drag * dt)
      p.vx *= d; p.vz *= d; p.vy = p.vy * d + p.lift * dt
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
      if (p.y < 0.05 && p.lift < 0) { p.y = 0.05; p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6 }
    }
    for (let k = 0; k < L.length; k++) {
      const p = L[k]
      const t = p.life / p.max
      this.pos[k * 3] = p.x; this.pos[k * 3 + 1] = p.y; this.pos[k * 3 + 2] = p.z
      this.size[k] = p.size0 + (p.size1 - p.size0) * t
      // 出てすぐ濃くなり、だんだん消える
      const fade = Math.min(1, t * 8) * (1 - t)
      this.tint[k * 4] = p.r; this.tint[k * 4 + 1] = p.g; this.tint[k * 4 + 2] = p.b; this.tint[k * 4 + 3] = p.a * fade
    }
    this.geo.setDrawRange(0, L.length)
    for (const n of ['position', 'size', 'tint']) this.geo.attributes[n].needsUpdate = true
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose() }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

export class Effects {
  readonly group = new THREE.Group()
  private smoke: ParticlePool
  private glow: ParticlePool
  private skids: SkidMarks
  private flashes: { light: THREE.PointLight; t: number }[] = []
  private weather: Weather | null = null
  private shards = new Shards()
  private tracers = new Tracers()
  private textures: THREE.Texture[] = []

  constructor(weather: 'clear' | 'rain' | 'snow') {
    const puff = TX.smokePuff()
    const dot = TX.softDot(64, 1.4)
    this.textures.push(puff, dot)
    this.smoke = new ParticlePool(1400, false, puff)
    this.glow = new ParticlePool(900, true, dot)
    this.skids = new SkidMarks()
    this.group.add(this.smoke.points, this.glow.points, this.skids.mesh, this.shards.mesh, this.tracers.lines)
    for (let k = 0; k < 2; k++) {
      const light = new THREE.PointLight(0xff8a3a, 0, 40, 1.6)
      this.group.add(light)
      this.flashes.push({ light, t: 1 })
    }
    if (weather !== 'clear') {
      this.weather = new Weather(weather, dot)
      this.group.add(this.weather.points)
    }
  }

  setPixelScale(h: number): void {
    this.smoke.mat.uniforms.scale.value = h * 0.9
    this.glow.mat.uniforms.scale.value = h * 0.9
    if (this.weather) this.weather.mat.uniforms.scale.value = h * 0.9
  }

  /** 車から出る煙（壊れかけ）。k は壊れ具合 0〜1 */
  engineSmoke(x: number, y: number, z: number, k: number): void {
    const dark = 0.55 - k * 0.45
    this.smoke.emit({ x: x + rnd(-0.3, 0.3), y, z: z + rnd(-0.3, 0.3), vx: rnd(-0.4, 0.4), vy: rnd(1, 2), vz: rnd(-0.4, 0.4),
                      life: 0, max: rnd(1.5, 2.6), size0: 0.8, size1: 3 + k * 3, r: dark, g: dark, b: dark,
                      a: 0.35 + k * 0.4, lift: 0.8, drag: 0.8 })
  }

  fire(x: number, y: number, z: number): void {
    this.glow.emit({ x: x + rnd(-0.6, 0.6), y, z: z + rnd(-0.6, 0.6), vx: rnd(-0.5, 0.5), vy: rnd(1.5, 3.5), vz: rnd(-0.5, 0.5),
                     life: 0, max: rnd(0.35, 0.7), size0: 1.6, size1: 0.4, r: 1, g: rnd(0.35, 0.6), b: 0.1, a: 0.9,
                     lift: 2, drag: 1.5 })
    if (Math.random() < 0.5) this.engineSmoke(x, y + 1, z, 1)
  }

  /** タイヤの煙・砂ぼこり */
  tireSmoke(x: number, z: number, k: number, dusty: boolean): void {
    const c = dusty ? [0.45, 0.4, 0.32] : [0.78, 0.78, 0.8]
    this.smoke.emit({ x, y: 0.3, z, vx: rnd(-1, 1), vy: rnd(0.3, 1), vz: rnd(-1, 1), life: 0, max: rnd(1, 2.2),
                      size0: 0.6, size1: 2.5 + k * 2, r: c[0], g: c[1], b: c[2], a: 0.18 + k * 0.25, lift: 0.3, drag: 1.2 })
  }

  sparks(x: number, y: number, z: number, n: number): void {
    for (let k = 0; k < n; k++) {
      this.glow.emit({ x, y, z, vx: rnd(-7, 7), vy: rnd(1, 6), vz: rnd(-7, 7), life: 0, max: rnd(0.25, 0.6),
                       size0: 0.25, size1: 0.05, r: 1, g: 0.75, b: 0.35, a: 1, lift: -14, drag: 0.5 })
    }
  }

  /** ぶつかったときの破片（ガラス・塗装のかけら） */
  debris(x: number, y: number, z: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const v = rnd(0.5, 0.9)
      this.smoke.emit({ x, y, z, vx: rnd(-5, 5), vy: rnd(2, 6), vz: rnd(-5, 5), life: 0, max: rnd(0.6, 1.2),
                        size0: 0.14, size1: 0.1, r: v, g: v, b: v + 0.05, a: 0.9, lift: -12, drag: 0.3 })
    }
  }

  /** ガラスが砕けて飛び散る（破片はそのまま路面に残る） */
  glass(x: number, y: number, z: number, n: number, vx = 0, vz = 0): void {
    this.shards.burst(x, y, z, n, vx, vz)
    for (let k = 0; k < 12; k++) {
      this.glow.emit({ x, y, z, vx: rnd(-4, 4) + vx * 0.3, vy: rnd(1, 4), vz: rnd(-4, 4) + vz * 0.3, life: 0, max: rnd(0.15, 0.4),
                       size0: 0.18, size1: 0.05, r: 0.8, g: 0.9, b: 1, a: 0.9, lift: -9, drag: 0.5 })
    }
  }

  /** 海に落ちた水しぶき */
  splash(x: number, z: number): void {
    for (let k = 0; k < 90; k++) {
      const a = Math.random() * Math.PI * 2, sp = rnd(1, 7)
      this.smoke.emit({ x, y: -1.2, z, vx: Math.sin(a) * sp, vy: rnd(3, 11), vz: Math.cos(a) * sp, life: 0, max: rnd(0.8, 1.8),
                        size0: rnd(0.6, 1.4), size1: rnd(2, 4), r: 0.92, g: 0.96, b: 1, a: 0.75, lift: -9, drag: 0.6 })
    }
  }

  /** ヘリからの銃撃: 弾の筋・着弾の火花と土ぼこり */
  shot(fx: number, fy: number, fz: number, tx: number, tz: number, hit: boolean): void {
    this.tracers.add(fx, fy, fz, tx, hit ? 0.8 : 0.05, tz)
    this.glow.emit({ x: fx, y: fy, z: fz, vx: 0, vy: 0, vz: 0, life: 0, max: 0.06, size0: 1.2, size1: 0.6, r: 1, g: 0.8, b: 0.4, a: 1, lift: 0, drag: 0 })
    if (hit) this.sparks(tx, 0.8, tz, 8)
    else {
      this.tireSmoke(tx, tz, 0.3, true)
      this.sparks(tx, 0.1, tz, 3)
    }
  }

  explosion(x: number, z: number): void {
    for (let k = 0; k < 70; k++) {
      const a = Math.random() * Math.PI * 2, s = rnd(2, 13)
      this.glow.emit({ x, y: 1, z, vx: Math.sin(a) * s, vy: rnd(1, 11), vz: Math.cos(a) * s, life: 0, max: rnd(0.4, 1.1),
                       size0: rnd(2, 4.5), size1: 0.5, r: 1, g: rnd(0.4, 0.75), b: 0.12, a: 1, lift: -2, drag: 2.2 })
    }
    for (let k = 0; k < 45; k++) {
      const a = Math.random() * Math.PI * 2, s = rnd(1, 6)
      const g = rnd(0.08, 0.2)
      this.smoke.emit({ x, y: 1.5, z, vx: Math.sin(a) * s, vy: rnd(2, 7), vz: Math.cos(a) * s, life: 0, max: rnd(2.5, 5),
                        size0: 3, size1: rnd(8, 14), r: g, g, b: g, a: 0.7, lift: 1.2, drag: 1.1 })
    }
    this.sparks(x, 1, z, 40)
    const f = this.flashes.reduce((a, b) => (a.t > b.t ? a : b))
    f.t = 0
    f.light.position.set(x, 3, z)
  }

  skid(x: number, z: number, yaw: number, width: number, alpha: number, id: number): void {
    this.skids.add(x, z, yaw, width, alpha, id)
  }

  skidLift(id: number): void { this.skids.lift(id) }

  update(dt: number, camera: THREE.Camera): void {
    this.smoke.update(dt)
    this.glow.update(dt)
    for (const f of this.flashes) {
      f.t += dt
      f.light.intensity = f.t < 1.2 ? 900 * Math.exp(-f.t * 3.2) * (0.8 + Math.random() * 0.4) : 0
    }
    this.weather?.update(dt, camera.position)
    this.shards.update(dt)
    this.tracers.update(dt)
  }

  dispose(): void {
    this.smoke.dispose()
    this.glow.dispose()
    this.skids.dispose()
    this.weather?.dispose()
    this.shards.dispose()
    this.tracers.dispose()
    for (const t of this.textures) t.dispose()
  }
}

/** タイヤ痕。黒い細長い四角を地面に置いていく（古いものから上書き） */
class SkidMarks {
  readonly mesh: THREE.Mesh
  private max = 1600
  private pos: Float32Array
  private alpha: Float32Array
  private next = 0
  private last = new Map<number, [number, number]>()

  constructor() {
    const g = new THREE.BufferGeometry()
    this.pos = new Float32Array(this.max * 4 * 3)
    this.alpha = new Float32Array(this.max * 4)
    const idx: number[] = []
    for (let k = 0; k < this.max; k++) idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3)
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(idx)
    const mat = new THREE.ShaderMaterial({
      vertexShader: `attribute float alpha; varying float vA;
        void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.03,0.03,0.03,vA); }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
  }

  /** id ごとに前の点とつないで帯にする（id はタイヤ 1 本ごと） */
  add(x: number, z: number, yaw: number, width: number, alpha: number, id: number): void {
    const prev = this.last.get(id)
    this.last.set(id, [x, z])
    if (!prev) return
    const d = Math.hypot(x - prev[0], z - prev[1])
    if (d > 3 || d < 0.05) { if (d > 3) this.last.set(id, [x, z]); return }
    const rx = Math.cos(yaw) * width / 2, rz = -Math.sin(yaw) * width / 2
    const k = this.next
    this.next = (this.next + 1) % this.max
    const y = 0.02
    const v = [prev[0] - rx, y, prev[1] - rz, prev[0] + rx, y, prev[1] + rz, x + rx, y, z + rz, x - rx, y, z - rz]
    this.pos.set(v, k * 12)
    this.alpha.fill(alpha, k * 4, k * 4 + 4)
    const g = this.mesh.geometry
    g.attributes.position.needsUpdate = true
    g.attributes.alpha.needsUpdate = true
  }

  /** 途切れさせる（滑っていないとき） */
  lift(id: number): void { this.last.delete(id) }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose() }
}

/**
 * ガラスの破片。小さな三角を InstancedMesh で何百枚も飛ばし、路面に落ちたらそのまま残す
 * （古いものから上書き）。つるつるの素材なので、光が当たるとキラキラ光る
 */
class Shards {
  readonly mesh: THREE.InstancedMesh
  private max = 1800
  private next = 0
  private items: { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; s: number; rest: boolean }[] = []
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private v = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private moving = new Set<number>()

  constructor() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.06, 0.05, 0, -0.04, -0.05, 0, -0.03], 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xcfe6ee, metalness: 0.6, roughness: 0.04, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    this.mesh = new THREE.InstancedMesh(g, mat, this.max)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  }

  burst(x: number, y: number, z: number, n: number, vx: number, vz: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next
      this.next = (this.next + 1) % this.max
      this.items[i] = {
        x: x + rnd(-0.5, 0.5), y: y + rnd(-0.2, 0.3), z: z + rnd(-0.5, 0.5),
        vx: rnd(-5, 5) + vx * 0.5, vy: rnd(1, 5), vz: rnd(-5, 5) + vz * 0.5,
        rx: rnd(0, 6), ry: rnd(0, 6), rz: rnd(0, 6), s: rnd(0.6, 2.2), rest: false,
      }
      this.moving.add(i)
      this.mesh.count = Math.max(this.mesh.count, i + 1)
      this.write(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  private write(i: number): void {
    const p = this.items[i]
    this.e.set(p.rx, p.ry, p.rz)
    this.q.setFromEuler(this.e)
    this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.sc.set(p.s, p.s, p.s))
    this.mesh.setMatrixAt(i, this.m)
  }

  update(dt: number): void {
    if (this.moving.size === 0) return
    for (const i of this.moving) {
      const p = this.items[i]
      p.vy -= 9.8 * dt
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
      p.rx += p.vx * dt * 3; p.rz += p.vz * dt * 3
      if (p.y <= 0.02) {
        p.y = 0.02
        if (Math.abs(p.vy) > 1.5) { p.vy *= -0.25; p.vx *= 0.5; p.vz *= 0.5 }
        else { p.rest = true; p.rx = Math.PI * (Math.random() < 0.5 ? 0 : 1) + rnd(-0.1, 0.1); p.rz = rnd(-0.1, 0.1) }
      }
      this.write(i)
      if (p.rest) this.moving.delete(i)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose() }
}

/** 弾の筋（一瞬だけ光る線） */
class Tracers {
  readonly lines: THREE.LineSegments
  private pos = new Float32Array(64 * 6)
  private life = new Float32Array(64)
  private next = 0

  constructor() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.9, toneMapped: false }))
    this.lines.frustumCulled = false
  }

  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const i = this.next
    this.next = (this.next + 1) % 64
    this.pos.set([x0, y0, z0, x1, y1, z1], i * 6)
    this.life[i] = 0.08
    this.lines.geometry.attributes.position.needsUpdate = true
  }

  update(dt: number): void {
    let changed = false
    for (let i = 0; i < 64; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) { this.pos.fill(0, i * 6, i * 6 + 6); changed = true }
    }
    if (changed) this.lines.geometry.attributes.position.needsUpdate = true
  }

  dispose(): void { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose() }
}

/** 雨・雪。カメラのまわりの箱の中だけで粒を降らせ、はみ出したら反対側へ戻す */
class Weather {
  readonly points: THREE.Points
  readonly mat: THREE.ShaderMaterial
  private pos: Float32Array
  private n: number
  private kind: 'rain' | 'snow'
  private box = 60
  private t = 0

  constructor(kind: 'rain' | 'snow', tex: THREE.Texture) {
    this.kind = kind
    this.n = kind === 'rain' ? 9000 : 6000
    this.pos = new Float32Array(this.n * 3)
    const size = new Float32Array(this.n)
    const tint = new Float32Array(this.n * 4)
    for (let k = 0; k < this.n; k++) {
      this.pos[k * 3] = rnd(-this.box, this.box)
      this.pos[k * 3 + 1] = rnd(0, 40)
      this.pos[k * 3 + 2] = rnd(-this.box, this.box)
      size[k] = kind === 'rain' ? rnd(0.05, 0.09) : rnd(0.08, 0.18)
      const c = kind === 'rain' ? [0.7, 0.75, 0.85, 0.35] : [1, 1, 1, 0.9]
      tint.set(c, k * 4)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('size', new THREE.BufferAttribute(size, 1))
    g.setAttribute('tint', new THREE.BufferAttribute(tint, 4))
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 600 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    })
    this.points = new THREE.Points(g, this.mat)
    this.points.frustumCulled = false
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.t += dt
    const fall = this.kind === 'rain' ? 26 : 2.2
    const b = this.box
    for (let k = 0; k < this.n; k++) {
      const i = k * 3
      this.pos[i + 1] -= fall * dt
      if (this.kind === 'snow') {
        this.pos[i] += Math.sin(this.t * 0.9 + k) * 0.6 * dt
        this.pos[i + 2] += Math.cos(this.t * 0.7 + k * 1.3) * 0.6 * dt
      }
      if (this.pos[i + 1] < 0) this.pos[i + 1] += 40
      // カメラの位置へ箱ごとついていく（はみ出したら反対側へ）
      let dx = this.pos[i] - cam.x
      if (dx > b) this.pos[i] -= 2 * b; else if (dx < -b) this.pos[i] += 2 * b
      dx = this.pos[i + 2] - cam.z
      if (dx > b) this.pos[i + 2] -= 2 * b; else if (dx < -b) this.pos[i + 2] += 2 * b
    }
    this.points.position.y = cam.y - 20
    this.points.geometry.attributes.position.needsUpdate = true
  }

  dispose(): void { this.points.geometry.dispose(); this.mat.dispose() }
}

