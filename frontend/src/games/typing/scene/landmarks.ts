// 目印（場所に入ったときに前から近づいてきて、通り過ぎる大きな物）。進んでいる感じを出すため。
// どれも簡単な形の組み合わせ。原点が道のまんなかで、+z が奥。ForestScene が歩いたぶん手前へ動かし、後ろへ消えたら片づける。

import * as THREE from 'three'
import type { Landmark } from './stages'

const wood = () => new THREE.MeshLambertMaterial({ color: 0x3a2a1c })
const stone = () => new THREE.MeshLambertMaterial({ color: 0x5a5a56 })
const glow = (c: number, k = 1.8) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) })

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, y, z)
  return m
}

function cyl(r: number, h: number, mat: THREE.Material, x: number, y: number, z: number, r2 = r): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r2, h, 10), mat)
  m.position.set(x, y, z)
  return m
}

export function buildLandmark(kind: Landmark): THREE.Group {
  const g = new THREE.Group()
  switch (kind) {
    case 'gate': {
      // 森の入口の古い木の門と、しめ縄
      const w = wood()
      g.add(cyl(0.35, 5.5, w, -3.2, 2.75, 0), cyl(0.35, 5.5, w, 3.2, 2.75, 0))
      g.add(box(8.5, 0.5, 0.6, w, 0, 5.4, 0), box(7.2, 0.3, 0.4, w, 0, 4.6, 0))
      const rope = new THREE.MeshLambertMaterial({ color: 0xd8cfa8 })
      g.add(box(6.2, 0.18, 0.18, rope, 0, 4.2, 0))
      for (const x of [-2, -0.7, 0.7, 2]) g.add(box(0.25, 0.7, 0.04, new THREE.MeshLambertMaterial({ color: 0xf2efe6 }), x, 3.7, 0))
      break
    }
    case 'jizo': {
      // 道ばたのお地蔵さま（赤いよだれかけ）
      const s = stone()
      const red = new THREE.MeshLambertMaterial({ color: 0xa0201a })
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const x = side * 3.1, z = i * 1.6
          g.add(cyl(0.28, 0.9, s, x, 0.45, z, 0.34))
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), s)
          head.position.set(x, 1.1, z)
          g.add(head)
          const bib = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.35, 10, 1, true), red)
          bib.position.set(x, 0.78, z)
          g.add(bib)
        }
      }
      break
    }
    case 'bigtree': {
      // 千年の大木（片側に、見上げるほど大きく）
      const w = new THREE.MeshLambertMaterial({ color: 0x2a1e16 })
      g.add(cyl(1.5, 16, w, 7, 8, 0, 2.2))
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const root = new THREE.Mesh(new THREE.ConeGeometry(0.5, 3, 6), w)
        root.position.set(7 + Math.cos(a) * 2, 0.6, Math.sin(a) * 2)
        root.rotation.set(Math.sin(a) * 1.2, 0, -Math.cos(a) * 1.2)
        g.add(root)
      }
      const crown = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 10), new THREE.MeshLambertMaterial({ color: 0x0c1e14 }))
      crown.position.set(6, 17, 0)
      g.add(crown)
      // しめ縄
      g.add(cyl(2.25, 0.3, new THREE.MeshLambertMaterial({ color: 0xd8cfa8 }), 7, 3, 0))
      break
    }
    case 'bridge': {
      // 板の橋（両側の欄干）
      const w = wood()
      for (let z = 0; z <= 14; z += 2) for (const x of [-2.4, 2.4]) g.add(cyl(0.12, 1.3, w, x, 0.65, z))
      for (const x of [-2.4, 2.4]) g.add(box(0.14, 0.14, 14.4, w, x, 1.2, 7))
      for (let z = 0; z < 14; z += 0.9) g.add(box(4.6, 0.08, 0.75, w, 0, 0.06, z))
      break
    }
    case 'stairs': {
      // 苔むした石段と、両側の石柱
      const s = stone()
      for (let i = 0; i < 9; i++) g.add(box(4.4, 0.12, 0.9, s, 0, 0.05, i * 1.3))
      for (const x of [-2.8, 2.8]) for (let i = 0; i < 3; i++) g.add(box(0.5, 1.6, 0.5, s, x, 0.8, i * 5))
      break
    }
    case 'lanterns': {
      // 提灯の列（ぼうっと光る）
      const w = wood()
      for (const side of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const x = side * 3, z = i * 3
          g.add(cyl(0.07, 2.6, w, x, 1.3, z))
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), glow(0xff8a3a))
          lamp.scale.y = 1.3
          lamp.position.set(x, 2.4, z)
          g.add(lamp)
        }
      }
      break
    }
    case 'shrine': {
      // 小さな社殿（片側に）
      const red = new THREE.MeshLambertMaterial({ color: 0x8a1c14 })
      g.add(box(4, 0.6, 3.4, stone(), 7, 0.3, 0))
      for (const [x, z] of [[5.3, -1.4], [8.7, -1.4], [5.3, 1.4], [8.7, 1.4]]) g.add(cyl(0.16, 2.4, red, x, 1.8, z))
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.6, 4), new THREE.MeshLambertMaterial({ color: 0x1e1814 }))
      roof.position.set(7, 3.8, 0)
      roof.rotation.y = Math.PI / 4
      g.add(roof)
      g.add(box(1.2, 1.4, 0.1, glow(0xffb060, 1.2), 7, 1.6, -1.45))
      break
    }
    case 'arch': {
      // 岩のアーチ（頭の上を通る）
      const arch = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.9, 8, 18, Math.PI), new THREE.MeshLambertMaterial({ color: 0x3a3a40 }))
      arch.position.set(0, 0, 0)
      g.add(arch)
      break
    }
    case 'stones': {
      // 立ち並ぶ石の柱
      const s = stone()
      for (let i = 0; i < 6; i++) {
        const side = i % 2 ? -1 : 1
        const p = box(0.9, 2 + (i % 3) * 0.8, 0.6, s, side * (3.6 + (i % 3) * 0.8), 1 + (i % 3) * 0.4, i * 2.2)
        p.rotation.z = side * 0.08
        g.add(p)
      }
      break
    }
    case 'rocks': {
      // 大きな岩
      const s = new THREE.MeshLambertMaterial({ color: 0x4a4844 })
      for (let i = 0; i < 7; i++) {
        const side = i % 2 ? -1 : 1
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(1 + (i % 3) * 0.7, 0), s)
        r.position.set(side * (4 + (i % 3) * 1.5), 0.6, i * 2.5)
        r.rotation.set(i, i * 2, 0)
        g.add(r)
      }
      break
    }
  }
  return g
}
