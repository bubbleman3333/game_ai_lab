// 光の粒。影を倒したときに舞い上がるホタル、ランタンの火の粉、森を漂うホタルに使う。
// 1 つの Points にまとめ、あらかじめ決めた数だけ使い回す（毎回作ると重いため）。

import * as THREE from 'three'

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aSize;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * (0.6 + a), a * vAlpha);
  }
`

export interface BurstOptions {
  count: number
  color: THREE.ColorRepresentation
  /** 飛び散る速さ（m/秒） */
  speed: number
  /** 何秒で消えるか */
  life: number
  size?: number
  /** 上へ浮く強さ（ホタルらしく、ゆっくり昇っていく） */
  lift?: number
}

export class Particles {
  readonly points: THREE.Points
  private pos: Float32Array
  private vel: Float32Array
  private col: Float32Array
  private alpha: Float32Array
  private size: Float32Array
  private baseSize: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private lift: Float32Array
  private flicker: Float32Array
  private next = 0
  private tmp = new THREE.Color()
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.pos = new Float32Array(capacity * 3)
    this.vel = new Float32Array(capacity * 3)
    this.col = new Float32Array(capacity * 3)
    this.alpha = new Float32Array(capacity)
    this.size = new Float32Array(capacity)
    this.baseSize = new Float32Array(capacity)
    this.life = new Float32Array(capacity)
    this.maxLife = new Float32Array(capacity)
    this.lift = new Float32Array(capacity)
    this.flicker = new Float32Array(capacity)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
  }

  burst(at: THREE.Vector3, o: BurstOptions): void {
    this.tmp.set(o.color)
    for (let n = 0; n < o.count; n++) {
      const i = this.next
      this.next = (this.next + 1) % this.capacity
      // 球の中からでたらめな向きに
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u)
      const sp = o.speed * (0.3 + Math.random() * 0.7)
      this.pos.set([at.x, at.y, at.z], i * 3)
      this.vel.set([r * Math.cos(th) * sp, u * sp * 0.7 + sp * 0.3, r * Math.sin(th) * sp], i * 3)
      this.col.set([this.tmp.r, this.tmp.g, this.tmp.b], i * 3)
      this.life[i] = this.maxLife[i] = o.life * (0.6 + Math.random() * 0.4)
      this.baseSize[i] = (o.size ?? 0.35) * (0.6 + Math.random() * 0.8)
      this.lift[i] = o.lift ?? 0.6
      this.flicker[i] = Math.random() * 10
    }
  }

  update(dt: number): void {
    const drag = Math.exp(-2.2 * dt)
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      this.life[i] -= dt
      const k = i * 3
      this.vel[k] *= drag
      this.vel[k + 1] = this.vel[k + 1] * drag + this.lift[i] * dt
      this.vel[k + 2] *= drag
      this.pos[k] += this.vel[k] * dt
      this.pos[k + 1] += this.vel[k + 1] * dt
      this.pos[k + 2] += this.vel[k + 2] * dt
      this.flicker[i] += dt * 7
      const t = Math.max(0, this.life[i] / this.maxLife[i])
      this.alpha[i] = t * (0.65 + 0.35 * Math.sin(this.flicker[i]))
      this.size[i] = this.baseSize[i] * (0.5 + 0.5 * t)
    }
    const geo = this.points.geometry
    for (const name of ['position', 'aColor', 'aAlpha', 'aSize']) geo.getAttribute(name).needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}

/** 森を漂うホタル（ずっと出ている）。歩くと後ろへ流れ、見えなくなったら前に戻す */
export class AmbientFireflies {
  readonly points: THREE.Points
  private base: Float32Array
  private phase: Float32Array
  private pos: Float32Array
  private alpha: Float32Array
  private time = 0
  private count: number

  constructor(count: number, color: THREE.ColorRepresentation) {
    this.count = count
    this.base = new Float32Array(count * 3)
    this.phase = new Float32Array(count)
    this.pos = new Float32Array(count * 3)
    this.alpha = new Float32Array(count)
    const col = new Float32Array(count * 3)
    const size = new Float32Array(count)
    const c = new THREE.Color(color)
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.5 ? -1 : 1
      this.base.set([side * (1.5 + Math.random() * 14), 0.4 + Math.random() * 3.5, Math.random() * 60 - 4], i * 3)
      this.phase[i] = Math.random() * 100
      col.set([c.r, c.g, c.b], i * 3)
      size[i] = 0.12 + Math.random() * 0.12
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
  }

  /** brightness: 0〜1（ボスを削るほど・夜明けほど増やすなど） */
  update(dt: number, walked: number, brightness: number): void {
    this.time += dt
    for (let i = 0; i < this.count; i++) {
      const k = i * 3
      this.base[k + 2] -= walked
      if (this.base[k + 2] < -4) this.base[k + 2] += 64
      const p = this.phase[i] + this.time
      this.pos[k] = this.base[k] + Math.sin(p * 0.5) * 0.8
      this.pos[k + 1] = this.base[k + 1] + Math.sin(p * 0.8) * 0.4
      this.pos[k + 2] = this.base[k + 2] + Math.cos(p * 0.4) * 0.8
      this.alpha[i] = brightness * Math.max(0, Math.sin(p * 1.7 + i)) ** 2
    }
    this.points.geometry.getAttribute('position').needsUpdate = true
    this.points.geometry.getAttribute('aAlpha').needsUpdate = true
  }

  dispose(): void {
    this.points.geometry.dispose()
    ;(this.points.material as THREE.Material).dispose()
  }
}
