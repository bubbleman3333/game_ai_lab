// 警察のヘリコプターの 3D。白と紺の機体、回るメインローター・テールローター、そり、
// 下向きのサーチライト（本物のスポットライト＋光の筋）。

import * as THREE from 'three'

export interface HeliModel {
  group: THREE.Group
  body: THREE.Group
  rotor: THREE.Object3D
  tail: THREE.Object3D
  light: THREE.SpotLight
  beam: THREE.Mesh
  dispose(): void
}

export function buildHeli(): HeliModel {
  const own: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => { own.push(x); return x }
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  const white = keep(new THREE.MeshPhysicalMaterial({ color: 0xf2f4f6, metalness: 0.3, roughness: 0.3, clearcoat: 1 }))
  const navy = keep(new THREE.MeshPhysicalMaterial({ color: 0x1b2d5a, metalness: 0.3, roughness: 0.3, clearcoat: 1 }))
  const glass = keep(new THREE.MeshPhysicalMaterial({ color: 0x0c1520, metalness: 0.9, roughness: 0.05 }))
  const dark = keep(new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.5 }))

  // 胴体: 前が丸く、後ろがすぼまった回転体
  const fus = keep(new THREE.LatheGeometry([
    [0.01, -2.6], [0.6, -2.3], [1.05, -1.5], [1.2, -0.3], [1.15, 0.8], [0.95, 1.6], [0.55, 2.3], [0.01, 2.6],
  ].map(([r, y]) => new THREE.Vector2(r, y)), 20).rotateX(Math.PI / 2).scale(0.85, 1, 1))
  const fuselage = new THREE.Mesh(fus, white)
  fuselage.position.y = 1.4
  const belly = new THREE.Mesh(keep(fus.clone().scale(1.01, 0.55, 0.98)), navy)
  belly.position.y = 1.0
  const canopy = new THREE.Mesh(keep(new THREE.SphereGeometry(1.0, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.9, 0.8, 1.3)), glass)
  canopy.position.set(0, 1.55, 1.3)
  canopy.rotation.x = 0.5
  const boom = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.2, 0.42, 5.6, 10).rotateX(Math.PI / 2)), white)
  boom.position.set(0, 1.75, -4.8)
  const fin = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 1.6, 0.9)), navy)
  fin.position.set(0, 2.4, -7.3)
  fin.rotation.x = -0.3
  const stab = new THREE.Mesh(keep(new THREE.BoxGeometry(1.8, 0.08, 0.5)), navy)
  stab.position.set(0, 1.8, -6.6)
  const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.15, 0.2, 0.7, 8)), dark)
  mast.position.y = 2.75
  body.add(fuselage, belly, canopy, boom, fin, stab, mast)
  // そり
  for (const s of [1, -1]) {
    const skid = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.07, 0.07, 3.8, 6).rotateX(Math.PI / 2)), dark)
    skid.position.set(s * 1.0, 0.1, 0.1)
    body.add(skid)
    for (const z of [-0.8, 1.0]) {
      const strut = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 5)), dark)
      strut.position.set(s * 0.85, 0.5, z)
      strut.rotation.z = s * 0.35
      body.add(strut)
    }
  }
  // メインローター（羽根 4 枚と、回転のぼやけ）
  const rotor = new THREE.Group()
  rotor.position.y = 3.1
  const blade = keep(new THREE.BoxGeometry(0.28, 0.04, 5.2).translate(0, 0, 2.6))
  for (let k = 0; k < 4; k++) {
    const b = new THREE.Mesh(blade, dark)
    b.rotation.y = (k / 4) * Math.PI * 2
    rotor.add(b)
  }
  const blur = new THREE.Mesh(keep(new THREE.CircleGeometry(5.3, 40).rotateX(-Math.PI / 2)),
    keep(new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })))
  blur.position.y = 3.1
  body.add(rotor, blur)
  const tail = new THREE.Group()
  tail.position.set(0.22, 2.3, -7.3)
  for (let k = 0; k < 2; k++) {
    const b = new THREE.Mesh(keep(new THREE.BoxGeometry(0.03, 1.3, 0.15)), dark)
    b.rotation.x = (k / 2) * Math.PI
    tail.add(b)
  }
  body.add(tail)
  // 衝突防止灯（赤）
  const beacon = new THREE.Mesh(keep(new THREE.SphereGeometry(0.12, 6, 4)), keep(new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false })))
  beacon.position.set(0, 0.6, -0.2)
  body.add(beacon)

  // サーチライト: 真下の少し前を照らす本物のライトと、夜に見える光の筋
  const light = new THREE.SpotLight(0xf4f8ff, 0, 140, 0.22, 0.5, 1.2)
  light.position.set(0, 0.4, 1.8)
  group.add(light, light.target)
  const beam = new THREE.Mesh(keep(new THREE.ConeGeometry(7, 40, 20, 1, true).translate(0, -20, 0)),
    keep(new THREE.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide })))
  group.add(beam)

  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true })
  beam.castShadow = false
  blur.castShadow = false
  return { group, body, rotor, tail, light, beam, dispose() { for (const d of own) d.dispose() } }
}
