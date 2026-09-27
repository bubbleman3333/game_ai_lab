// 演出の粒（泡・水しぶき・刺されたときの火花・真珠のきらめき）。
//
// ここは見た目だけで、ルールには一切影響しない。
// 粒は最初にまとめて作っておき、使い回す（毎フレーム作ると重いため）。
// 粒ごとに「重さ」を持ち、泡は上へ（負の重さ）、しぶきは下へ落ちる。

import * as THREE from 'three'

const MAX = 900

function puffTexture(): THREE.Texture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class Particles {
  readonly points: THREE.Points
  private pos = new Float32Array(MAX * 3)
  private col = new Float32Array(MAX * 3)
  private size = new Float32Array(MAX)
  private vel = new Float32Array(MAX * 3)
  private life = new Float32Array(MAX)
  private maxLife = new Float32Array(MAX)
  private gravity = new Float32Array(MAX)
  private baseSize = new Float32Array(MAX)
  /** 海面より上に出たら消す粒（泡）は true */
  private popAtSurface = new Uint8Array(MAX)
  private next = 0
  private geo: THREE.BufferGeometry
  private mat: THREE.ShaderMaterial
  private tex: THREE.Texture

  constructor() {
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3))
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1))
    this.tex = puffTexture()
    // 粒ごとに大きさを変えたいので、PointsMaterial ではなく小さなシェーダーを使う
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.tex }, scale: { value: 300 } },
      transparent: true, depthWrite: false,
      vertexShader: `
attribute float size;
varying vec3 vColor;
uniform float scale;
void main() {
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / max(-mv.z, 0.5);
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: `
uniform sampler2D map;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vColor, t.a * 0.7);
}`,
      vertexColors: true,
    })
    this.points = new THREE.Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 20
  }

  /** 画面の高さに合わせて粒の大きさを直す */
  resize(heightPx: number): void {
    this.mat.uniforms.scale.value = heightPx * 0.5
  }

  emit(x: number, y: number, z: number, color: THREE.Color, size: number, life: number,
       vx = 0, vy = 0, vz = 0, gravity = 0, popAtSurface = false): void {
    const i = this.next
    this.next = (this.next + 1) % MAX
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b
    this.size[i] = size
    this.baseSize[i] = size
    this.life[i] = life
    this.maxLife[i] = life
    this.gravity[i] = gravity
    this.popAtSurface[i] = popAtSurface ? 1 : 0
  }

  /** 泡（水中から上へ） */
  bubble(x: number, y: number, z: number, n = 1, spread = 0.3): void {
    for (let i = 0; i < n; i++) {
      this.emit(x + (Math.random() - 0.5) * spread, y, z + (Math.random() - 0.5) * spread,
                BUBBLE, 0.12 + Math.random() * 0.14, 1.5 + Math.random() * 1.5,
                (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4, -1.2, true)
    }
  }

  /** 水しぶき（海面から上へ跳ねて落ちる） */
  splash(x: number, y: number, z: number, n: number, power: number): void {
    for (let i = 0; i < n; i++) {
      this.emit(x, y, z, SPRAY, 0.18 + Math.random() * 0.25, 0.4 + Math.random() * 0.4,
                (Math.random() - 0.5) * 2.5 * power, (1.2 + Math.random() * 2.2) * power, (Math.random() - 0.5) * 2.5 * power,
                9)
    }
  }

  /** 火花（刺された・真珠を拾った） */
  burst(x: number, y: number, z: number, color: THREE.Color, n: number, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * Math.PI
      this.emit(x, y, z, color, 0.15 + Math.random() * 0.2, 0.4 + Math.random() * 0.5,
                Math.cos(a) * Math.cos(b) * speed, Math.sin(b) * speed, Math.sin(a) * Math.cos(b) * speed, 0)
    }
  }

  update(dt: number, surfaceY: (x: number, z: number) => number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) { this.size[i] = 0; continue }
      this.vel[i * 3 + 1] -= this.gravity[i] * dt
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      if (this.popAtSurface[i] && this.pos[i * 3 + 1] > surfaceY(this.pos[i * 3], this.pos[i * 3 + 2])) {
        this.life[i] = 0
        this.size[i] = 0
        continue
      }
      const k = this.life[i] / this.maxLife[i]
      // 泡は上がるほど大きく、しぶきは消え際に小さく
      this.size[i] = this.baseSize[i] * (this.popAtSurface[i] ? 1.4 - 0.4 * k : Math.min(1, k * 3))
    }
    ;(this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }
}

const BUBBLE = new THREE.Color(0xd8f4ff)
const SPRAY = new THREE.Color(0xffffff)
export const STING_COLOR = new THREE.Color(0xd070ff)
export const PEARL_COLOR = new THREE.Color(0xffe9a0)
export const BLOOD_COLOR = new THREE.Color(0xb01818)
