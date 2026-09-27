// 水中だけの演出: 海面から差し込む光の筋（ゴッドレイ）と、漂う細かい粒（マリンスノー）。
//
// どちらも見た目だけで、ルールには影響しない。カメラが水に入っているときだけ見せ、
// 深く潜るほど光の筋は薄くなる（光が届かなくなる）。

import * as THREE from 'three'

const RAYS = 9
const SNOW = 900
const SNOW_BOX = 44 // 粒を散らす箱の一辺（カメラを中心に）

function rayTexture(): THREE.Texture {
  const w = 64, h = 256
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const g = canvas.getContext('2d')!
  // 上が明るく下へ消える。左右の端も柔らかく
  const img = g.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    const v = Math.pow(1 - y / h, 1.6)
    for (let x = 0; x < w; x++) {
      const u = Math.sin((x / (w - 1)) * Math.PI)
      const a = v * Math.pow(u, 1.4)
      const i = (y * w + x) * 4
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255)
    }
  }
  g.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function dotTexture(): THREE.Texture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class Underwater {
  readonly group = new THREE.Group()
  private rays: THREE.Mesh[] = []
  private rayOffsets: [number, number, number][] = [] // 泳ぐ人からの x, z のずれと幅
  private rayMat: THREE.MeshBasicMaterial
  private rayTex: THREE.Texture
  private rayGeo: THREE.PlaneGeometry
  private snow: THREE.Points
  private snowGeo: THREE.BufferGeometry
  private snowMat: THREE.PointsMaterial
  private snowTex: THREE.Texture
  private snowPos: Float32Array
  private snowDrift: Float32Array

  constructor() {
    this.rayTex = rayTexture()
    this.rayGeo = new THREE.PlaneGeometry(1, 1)
    this.rayGeo.translate(0, -0.5, 0) // 上端が原点（海面に置く）
    this.rayMat = new THREE.MeshBasicMaterial({
      map: this.rayTex, color: 0xdff4ff, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    })
    for (let i = 0; i < RAYS; i++) {
      const m = new THREE.Mesh(this.rayGeo, this.rayMat)
      m.renderOrder = 15
      m.frustumCulled = false
      this.rays.push(m)
      this.group.add(m)
      this.rayOffsets.push([(Math.random() - 0.5) * 36, 4 + Math.random() * 34, 2.5 + Math.random() * 4])
    }

    this.snowTex = dotTexture()
    this.snowPos = new Float32Array(SNOW * 3)
    this.snowDrift = new Float32Array(SNOW * 3)
    for (let i = 0; i < SNOW; i++) {
      this.snowPos[i * 3] = (Math.random() - 0.5) * SNOW_BOX
      this.snowPos[i * 3 + 1] = (Math.random() - 0.5) * SNOW_BOX
      this.snowPos[i * 3 + 2] = (Math.random() - 0.5) * SNOW_BOX
      this.snowDrift[i * 3] = (Math.random() - 0.5) * 0.3
      this.snowDrift[i * 3 + 1] = -0.05 - Math.random() * 0.15
      this.snowDrift[i * 3 + 2] = (Math.random() - 0.5) * 0.3
    }
    this.snowGeo = new THREE.BufferGeometry()
    this.snowGeo.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3))
    this.snowMat = new THREE.PointsMaterial({
      map: this.snowTex, color: 0xcfe6f5, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0,
      depthWrite: false,
    })
    this.snow = new THREE.Points(this.snowGeo, this.snowMat)
    this.snow.frustumCulled = false
    this.snow.renderOrder = 16
    this.group.add(this.snow)
  }

  /**
   * @param under    カメラが水の中か
   * @param depthK   カメラの深さ（0 = 海面, 1 = 一番深い）
   * @param light    その区間の光の強さ（0〜1。夜は弱い）
   */
  update(dt: number, cam: THREE.Vector3, playerX: number, playerZ: number, sunDir: THREE.Vector3,
         under: boolean, depthK: number, light: number, surfaceY: (x: number, z: number) => number): void {
    this.group.visible = under
    if (!under) return

    // 光の筋: 海面から太陽の向きに沿って斜めに差し、カメラのほうを向く板。深いほど薄い
    this.rayMat.opacity = 0.32 * light * Math.max(0, 1 - depthK * 1.4)
    const tilt = Math.atan2(Math.hypot(sunDir.x, sunDir.z), sunDir.y)
    this.rays.forEach((m, i) => {
      const [ox, oz, w] = this.rayOffsets[i]
      const x = playerX + ox, z = playerZ + oz
      m.position.set(x, surfaceY(x, z) - 0.2, z)
      m.scale.set(w, 40, 1)
      // カメラのほうを向き（y 軸まわり）、太陽の向きへ傾ける
      m.rotation.set(0, Math.atan2(cam.x - x, cam.z - z), 0)
      m.rotation.x = -tilt * 0.6
    })

    // 粒: カメラを中心にした箱の中で漂わせ、外に出たら反対側へ戻す
    this.snowMat.opacity = 0.35 + 0.25 * depthK
    const half = SNOW_BOX / 2
    for (let i = 0; i < SNOW; i++) {
      let x = this.snowPos[i * 3] + this.snowDrift[i * 3] * dt
      let y = this.snowPos[i * 3 + 1] + this.snowDrift[i * 3 + 1] * dt
      let z = this.snowPos[i * 3 + 2] + this.snowDrift[i * 3 + 2] * dt
      // 箱はカメラについて回るので、位置はカメラからの相対で持つ
      if (x > half) x -= SNOW_BOX; else if (x < -half) x += SNOW_BOX
      if (y > half) y -= SNOW_BOX; else if (y < -half) y += SNOW_BOX
      if (z > half) z -= SNOW_BOX; else if (z < -half) z += SNOW_BOX
      this.snowPos[i * 3] = x; this.snowPos[i * 3 + 1] = y; this.snowPos[i * 3 + 2] = z
    }
    this.snow.position.copy(cam)
    ;(this.snowGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.rayGeo.dispose(); this.rayMat.dispose(); this.rayTex.dispose()
    this.snowGeo.dispose(); this.snowMat.dispose(); this.snowTex.dispose()
  }
}
