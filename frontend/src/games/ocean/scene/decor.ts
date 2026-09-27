// 海底の飾り（岩・サンゴ・海藻）。浅瀬でだけ海底が見えるので、浅瀬の区間にだけ置く。
//
// 40m ごとの「区画」に分けて、泳ぐ人の前方の区画を作り、後ろに流れた区画を片づける。
// 区画の中身は区画の番号を種にした乱数で決めるので、同じ区画は毎回同じ形になる。

import * as THREE from 'three'
import { Rng } from '../sim/rng'
import { floorBump } from './water'

const CHUNK = 40
const AHEAD = 5 // 前方いくつの区画を用意するか
const LANE = 30

interface Chunk {
  group: THREE.Group
  weeds: { mesh: THREE.Mesh; phase: number }[]
}

export class Decor {
  readonly group = new THREE.Group()
  private chunks = new Map<number, Chunk>()
  private rockGeo = new THREE.DodecahedronGeometry(1, 0)
  private rockMat = new THREE.MeshStandardMaterial({ color: 0x6f6a5e, roughness: 0.95, flatShading: true })
  private coralGeo = new THREE.ConeGeometry(0.35, 1.4, 6)
  private coralMats = [0xff7a4d, 0xff5c8a, 0xb06cff, 0xffc94d].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, flatShading: true }))
  private weedGeo = new THREE.BoxGeometry(0.18, 1, 0.05)
  private weedMat = new THREE.MeshStandardMaterial({ color: 0x2f9a4a, roughness: 0.9, side: THREE.DoubleSide })
  private starGeo: THREE.BufferGeometry
  private starMat = new THREE.MeshStandardMaterial({ color: 0xff8a3a, roughness: 0.9, flatShading: true })

  private floorYAt: (z: number) => number | null

  constructor(floorYAt: (z: number) => number | null) {
    this.floorYAt = floorYAt
    this.weedGeo.translate(0, 0.5, 0) // 根元を原点にして、根元を軸に揺らす
    // ヒトデ（星形を薄く押し出す）
    const shape = new THREE.Shape()
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 0.5 : 0.2
      const a = (i / 10) * Math.PI * 2
      if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r)
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r)
    }
    shape.closePath()
    this.starGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false })
    this.starGeo.rotateX(-Math.PI / 2)
  }

  private build(k: number, floorY: number): Chunk {
    const rng = new Rng(k * 7919 + 13)
    const group = new THREE.Group()
    const weeds: Chunk['weeds'] = []
    const z0 = k * CHUNK
    const at = (x: number, z: number) => floorY + floorBump(x, z)

    for (let i = rng.int(2, 5); i > 0; i--) {
      const x = rng.range(-LANE, LANE), z = z0 + rng.range(0, CHUNK)
      const rock = new THREE.Mesh(this.rockGeo, this.rockMat)
      const s = rng.range(0.7, 2.4)
      rock.scale.set(s * rng.range(0.8, 1.4), s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.4))
      rock.position.set(x, at(x, z) - s * 0.2, z)
      rock.rotation.set(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3))
      group.add(rock)
    }
    for (let i = rng.int(3, 7); i > 0; i--) {
      const cx = rng.range(-LANE, LANE), cz = z0 + rng.range(0, CHUNK)
      const mat = rng.pick(this.coralMats)
      for (let j = rng.int(3, 6); j > 0; j--) {
        const c = new THREE.Mesh(this.coralGeo, mat)
        const x = cx + rng.range(-0.8, 0.8), z = cz + rng.range(-0.8, 0.8)
        const h = rng.range(0.6, 1.6)
        c.scale.set(rng.range(0.7, 1.3), h, rng.range(0.7, 1.3))
        c.position.set(x, at(x, z) + 0.6 * h, z)
        c.rotation.set(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3))
        group.add(c)
      }
    }
    for (let i = rng.int(3, 6); i > 0; i--) {
      const cx = rng.range(-LANE, LANE), cz = z0 + rng.range(0, CHUNK)
      for (let j = rng.int(4, 9); j > 0; j--) {
        const w = new THREE.Mesh(this.weedGeo, this.weedMat)
        const x = cx + rng.range(-1.5, 1.5), z = cz + rng.range(-1.5, 1.5)
        w.scale.set(1, rng.range(1.5, 3.5), 1)
        w.position.set(x, at(x, z) - 0.1, z)
        w.rotation.y = rng.range(0, Math.PI)
        group.add(w)
        weeds.push({ mesh: w, phase: rng.range(0, 6) })
      }
    }
    for (let i = rng.int(0, 2); i > 0; i--) {
      const x = rng.range(-LANE, LANE), z = z0 + rng.range(0, CHUNK)
      const s = new THREE.Mesh(this.starGeo, this.starMat)
      s.position.set(x, at(x, z) + 0.05, z)
      s.rotation.y = rng.range(0, 3)
      s.scale.setScalar(rng.range(0.8, 1.4))
      group.add(s)
    }
    this.group.add(group)
    return { group, weeds }
  }

  update(t: number, playerZ: number): void {
    const k0 = Math.floor((playerZ - CHUNK) / CHUNK)
    for (const [k, c] of this.chunks) {
      if (k < k0) { this.group.remove(c.group); this.chunks.delete(k) }
    }
    for (let k = Math.max(0, k0); k <= k0 + AHEAD + 1; k++) {
      if (this.chunks.has(k)) continue
      const floorY = this.floorYAt(k * CHUNK)
      if (floorY === null) continue // 海底が見えない区間には置かない
      this.chunks.set(k, this.build(k, floorY))
    }
    // 海藻を揺らす
    for (const c of this.chunks.values()) {
      for (const w of c.weeds) w.mesh.rotation.z = Math.sin(t * 1.1 + w.phase) * 0.18
    }
  }

  dispose(): void {
    for (const d of [this.rockGeo, this.rockMat, this.coralGeo, ...this.coralMats, this.weedGeo, this.weedMat,
                     this.starGeo, this.starMat]) d.dispose()
    this.chunks.clear()
  }
}
