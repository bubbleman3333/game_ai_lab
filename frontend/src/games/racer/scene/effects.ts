// 演出（タイヤの煙・着地の土ぼこり・ブーストの炎）。
//
// ここは見た目だけで、走りには一切影響しない（Python 版にも存在しない）。
// 粒は最初にまとめて作っておき、使い回す（毎フレーム作ると重いため）。

import * as THREE from 'three'

const MAX = 700

/**
 * 粒 1 つぶんの絵（中心が濃く、外へいくほど薄い丸）。
 * これを貼らないと、粒が四角いブロックのまま描かれて煙に見えない。
 */
function puffTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 煙やほこりの粒をまとめて管理する */
export class Particles {
  readonly points: THREE.Points
  private pos: Float32Array
  private col: Float32Array
  private size: Float32Array
  private vel = new Float32Array(MAX * 3)
  private life = new Float32Array(MAX)
  private maxLife = new Float32Array(MAX)
  private next = 0
  private geo: THREE.BufferGeometry
  private mat: THREE.PointsMaterial
  private tex: THREE.Texture

  constructor() {
    this.pos = new Float32Array(MAX * 3)
    this.col = new Float32Array(MAX * 3)
    this.size = new Float32Array(MAX)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1))
    this.tex = puffTexture()
    this.mat = new THREE.PointsMaterial({
      vertexColors: true, size: 2.6, sizeAttenuation: true, map: this.tex,
      transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
    for (let i = 0; i < MAX; i++) this.size[i] = 0
  }

  emit(x: number, y: number, z: number, color: THREE.Color, size: number, life: number,
       vx = 0, vy = 0, vz = 0): void {
    const i = this.next
    this.next = (this.next + 1) % MAX
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b
    this.size[i] = size
    this.life[i] = life
    this.maxLife[i] = life
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue }
      this.life[i] -= dt
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.vel[i * 3 + 1] += 3 * dt // ふわっと上がる
      const k = Math.max(this.life[i] / this.maxLife[i], 0)
      this.size[i] = this.size[i] * 0.995 + 0.02 * k // 消えぎわに小さくなる
    }
    this.geo.attributes.position.needsUpdate = true
    this.geo.attributes.color.needsUpdate = true
    this.geo.attributes.size.needsUpdate = true
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose(); this.tex.dispose() }
}

/** ブーストのときにマフラーから出る炎 */
export class Flame {
  readonly group = new THREE.Group()
  private cones: THREE.Mesh[] = []
  private geo: THREE.ConeGeometry
  private mat: THREE.MeshBasicMaterial

  constructor(offsets: [number, number, number][], color = 0x66ccff) {
    this.geo = new THREE.ConeGeometry(0.22, 1.1, 8, 1, true)
    this.mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })
    for (const [x, y, z] of offsets) {
      const m = new THREE.Mesh(this.geo, this.mat)
      m.position.set(x, y, z)
      m.rotation.x = -Math.PI / 2 // 後ろへ向ける
      m.scale.setScalar(0)
      this.group.add(m)
      this.cones.push(m)
    }
  }

  /** strength: 0（消えている）〜1（全開） */
  update(strength: number, time: number): void {
    for (let i = 0; i < this.cones.length; i++) {
      const flicker = 0.82 + 0.18 * Math.sin(time * 40 + i * 2.1)
      const s = strength * flicker
      this.cones[i].scale.set(s, s * (1 + strength * 0.9), s)
    }
    this.mat.opacity = 0.35 + 0.5 * strength
  }

  dispose(): void { this.geo.dispose(); this.mat.dispose() }
}
