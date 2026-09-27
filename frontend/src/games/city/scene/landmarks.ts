// 街の目印（sim/cityMap.ts の landmarks）と、住宅街の電柱・電線の 3D。
//
//   電波塔  赤と白の鉄骨の塔（高さ約 230m）。どこからでも見えて、自分がどのあたりにいるか分かる。夜は航空障害灯が点滅
//   神社    朱色の鳥居・石灯籠・社殿・大きな木
//   池      公園の池と、真ん中の噴水（水しぶきが上がる）
//   電柱    住宅街の道ぞい。電線が少したるんで張られている（日本の住宅街らしさ）

import * as THREE from 'three'
import { CURB_HEIGHT, type CityMap } from '../sim/cityMap'

export interface Landmarks {
  group: THREE.Group
  update(dt: number, time: number, night: number): void
  dispose(): void
}

export function buildLandmarks(map: CityMap): Landmarks {
  const group = new THREE.Group()
  const own: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => { own.push(x); return x }
  const red = keep(new THREE.MeshStandardMaterial({ color: 0xd8401e, roughness: 0.55, metalness: 0.3 }))
  const white = keep(new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.55, metalness: 0.3 }))
  const stone = keep(new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.95 }))
  const wood = keep(new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 0.8 }))
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: 0x3c4a42, roughness: 0.6, metalness: 0.4 }))
  const blinkMat = keep(new THREE.MeshBasicMaterial({ color: 0xff2010, toneMapped: false }))
  const beamGeo = keep(new THREE.CylinderGeometry(0.18, 0.18, 1, 5))
  const beams: { a: THREE.Vector3; b: THREE.Vector3; mat: THREE.Material; r: number }[] = []
  let fountain: THREE.Points | null = null
  const fountainVel: number[] = []

  /** 2 点を結ぶ鉄骨（細い円柱） */
  const beam = (a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material, r = 1) => beams.push({ a, b, mat, r })

  for (const lm of map.landmarks) {
    const base = new THREE.Vector3(lm.x, CURB_HEIGHT, lm.z)
    if (lm.kind === 'tower') {
      // 4 本の脚が上へすぼまる鉄塔。高さごとに赤と白を塗り分け、横と斜めの補強材を入れる
      const H = 230
      const halfAt = (y: number) => 9 * Math.pow(1 - y / H, 1.6) + 0.8
      const levels = 26
      for (let k = 0; k < levels; k++) {
        const y0 = (k / levels) * H, y1 = ((k + 1) / levels) * H
        const h0 = halfAt(y0), h1 = halfAt(y1)
        const mat = Math.floor(k / 2) % 2 === 0 ? red : white
        const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]]
        for (let c = 0; c < 4; c++) {
          const [sx, sz] = corners[c]
          const [tx, tz] = corners[(c + 1) % 4]
          const p0 = base.clone().add(new THREE.Vector3(sx * h0, y0, sz * h0))
          const p1 = base.clone().add(new THREE.Vector3(sx * h1, y1, sz * h1))
          beam(p0, p1, mat, 2.2)
          const q1 = base.clone().add(new THREE.Vector3(tx * h1, y1, tz * h1))
          beam(p1, q1, mat, 1)
          beam(p0, q1, mat, 0.7)
        }
      }
      // 展望台（2 段）とアンテナ
      for (const [y, r, h] of [[120, 7, 8], [185, 4.5, 5]] as const) {
        const deck = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r * 0.9, h, 16)), white)
        deck.position.set(lm.x, CURB_HEIGHT + y, lm.z)
        const glass = new THREE.Mesh(keep(new THREE.CylinderGeometry(r * 1.02, r * 1.02, h * 0.5, 16)),
          keep(new THREE.MeshStandardMaterial({ color: 0x223344, metalness: 0.8, roughness: 0.1, emissive: 0xffd9a0, emissiveIntensity: 0 })))
        glass.position.copy(deck.position)
        glass.userData.glow = true
        group.add(deck, glass)
      }
      const ant = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.4, 0.8, 30, 8)), red)
      ant.position.set(lm.x, CURB_HEIGHT + H + 15, lm.z)
      group.add(ant)
      for (const y of [60, 120, 185, H + 29]) {
        const l = new THREE.Mesh(keep(new THREE.SphereGeometry(0.9, 8, 6)), blinkMat)
        l.position.set(lm.x, CURB_HEIGHT + y, lm.z)
        l.userData.blink = true
        group.add(l)
      }
    } else if (lm.kind === 'shrine') {
      const vermilion = keep(new THREE.MeshStandardMaterial({ color: 0xc8341c, roughness: 0.6 }))
      const black = keep(new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }))
      // 鳥居（社殿の 12m 手前）
      const torii = new THREE.Group()
      torii.position.set(lm.x, CURB_HEIGHT, lm.z - 12)
      for (const sx of [-2.4, 2.4]) {
        const pillar = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.3, 0.36, 6, 14)), vermilion)
        pillar.position.set(sx, 3, 0)
        const foot = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 14)), black)
        foot.position.set(sx, 0.25, 0)
        torii.add(pillar, foot)
      }
      const kasagi = new THREE.Mesh(keep(new THREE.BoxGeometry(7.6, 0.45, 0.7)), black)
      kasagi.position.y = 6.25
      const shimaki = new THREE.Mesh(keep(new THREE.BoxGeometry(7.0, 0.35, 0.55)), vermilion)
      shimaki.position.y = 5.9
      const nuki = new THREE.Mesh(keep(new THREE.BoxGeometry(6.2, 0.3, 0.3)), vermilion)
      nuki.position.y = 4.9
      torii.add(kasagi, shimaki, nuki)
      group.add(torii)
      // 参道の石灯籠
      for (const dz of [-8, -4, 0]) {
        for (const sx of [-3.2, 3.2]) {
          const t = new THREE.Group()
          t.position.set(lm.x + sx, CURB_HEIGHT, lm.z + dz)
          const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.18, 0.25, 1.2, 8)), stone)
          post.position.y = 0.6
          const box = new THREE.Mesh(keep(new THREE.BoxGeometry(0.6, 0.45, 0.6)), stone)
          box.position.y = 1.4
          const light = new THREE.Mesh(keep(new THREE.BoxGeometry(0.36, 0.3, 0.62)),
            keep(new THREE.MeshStandardMaterial({ color: 0x333, emissive: 0xffb050, emissiveIntensity: 0 })))
          light.position.y = 1.4
          light.userData.glow = true
          const cap = new THREE.Mesh(keep(new THREE.ConeGeometry(0.6, 0.4, 4)), stone)
          cap.position.y = 1.85
          cap.rotation.y = Math.PI / 4
          t.add(post, box, light, cap)
          group.add(t)
        }
      }
      // 社殿: 高床の本殿と、反った大きな屋根
      const hall = new THREE.Group()
      hall.position.set(lm.x, CURB_HEIGHT, lm.z + 6)
      const floor = new THREE.Mesh(keep(new THREE.BoxGeometry(10, 1.2, 8)), stone)
      floor.position.y = 0.6
      const body = new THREE.Mesh(keep(new THREE.BoxGeometry(8, 3.4, 6)), wood)
      body.position.y = 2.9
      const roofShape = new THREE.Shape()
      roofShape.moveTo(-6.4, 0)
      roofShape.quadraticCurveTo(-3, 0.6, 0, 3.2)
      roofShape.quadraticCurveTo(3, 0.6, 6.4, 0)
      roofShape.lineTo(-6.4, 0)
      const roofGeo = keep(new THREE.ExtrudeGeometry(roofShape, { depth: 9, bevelEnabled: false, curveSegments: 10 }))
      roofGeo.translate(0, 0, -4.5)
      const roof = new THREE.Mesh(roofGeo, roofMat)
      roof.position.y = 4.6
      hall.add(floor, body, roof)
      group.add(hall)
      // ご神木（大きな木）
      for (const [dx, dz, s] of [[-9, 4, 1.6], [9, 8, 1.4], [-8, -14, 1.2], [8, -15, 1.3]] as const) {
        const trunk = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.35 * s, 0.6 * s, 7 * s, 10)), wood)
        trunk.position.set(lm.x + dx, CURB_HEIGHT + 3.5 * s, lm.z + dz)
        const crown = new THREE.Mesh(keep(new THREE.IcosahedronGeometry(3.6 * s, 3)),
          keep(new THREE.MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.85 })))
        crown.position.set(lm.x + dx, CURB_HEIGHT + 8 * s, lm.z + dz)
        crown.scale.set(1, 0.85, 1)
        group.add(trunk, crown)
      }
    } else if (lm.kind === 'pond') {
      // 池: 石で縁取った丸い水面と、真ん中の噴水
      const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(11, 0.6, 8, 48)), stone)
      rim.rotation.x = Math.PI / 2
      rim.position.set(lm.x, CURB_HEIGHT + 0.2, lm.z)
      const water = new THREE.Mesh(keep(new THREE.CircleGeometry(11, 48)),
        keep(new THREE.MeshStandardMaterial({ color: 0x1d3f4a, roughness: 0.05, metalness: 0.3 })))
      water.rotation.x = -Math.PI / 2
      water.position.set(lm.x, CURB_HEIGHT + 0.12, lm.z)
      const bowl = new THREE.Mesh(keep(new THREE.CylinderGeometry(1.6, 2, 1.2, 20)), stone)
      bowl.position.set(lm.x, CURB_HEIGHT + 0.6, lm.z)
      group.add(rim, water, bowl)
      // 噴水の水しぶき（点の集まりを上へ飛ばしては落とす）
      const n = 600
      const pos = new Float32Array(n * 3)
      for (let k = 0; k < n; k++) {
        pos[k * 3] = lm.x; pos[k * 3 + 1] = CURB_HEIGHT + 1.2 + Math.random() * 5; pos[k * 3 + 2] = lm.z
        const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 0.8
        fountainVel.push(Math.sin(a) * sp, 5 + Math.random() * 3, Math.cos(a) * sp)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
      fountain = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xdff4ff, size: 0.12, transparent: true, opacity: 0.8 }))
      fountain.userData.origin = [lm.x, CURB_HEIGHT + 1.2, lm.z]
      group.add(fountain)
      own.push(g, fountain.material as THREE.Material)
    }
  }

  // 鉄骨は向きと長さの違う円柱。材料ごとに InstancedMesh にまとめる
  const byMat = new Map<THREE.Material, typeof beams>()
  for (const b of beams) { const l = byMat.get(b.mat) ?? []; l.push(b); byMat.set(b.mat, l) }
  const up = new THREE.Vector3(0, 1, 0)
  for (const [mat, list] of byMat) {
    const im = new THREE.InstancedMesh(beamGeo, mat, list.length)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    list.forEach((b, k) => {
      const d = b.b.clone().sub(b.a)
      q.setFromUnitVectors(up, d.clone().normalize())
      m.compose(b.a.clone().add(b.b).multiplyScalar(0.5), q, s.set(b.r, d.length(), b.r))
      im.setMatrixAt(k, m)
    })
    im.castShadow = true
    group.add(im)
    own.push(im)
  }

  // --- 電柱と電線 -------------------------------------------------------------------------
  const poles = map.props.filter((p) => p.kind === 'pole')
  const poleMat = keep(new THREE.MeshStandardMaterial({ color: 0x9c9a94, roughness: 0.8 }))
  const poleGeo = keep(new THREE.CylinderGeometry(0.14, 0.2, 10, 10).translate(0, 5, 0))
  const armGeo = keep(new THREE.BoxGeometry(1.6, 0.12, 0.12).translate(0, 8.8, 0))
  const transGeo = keep(new THREE.CylinderGeometry(0.35, 0.35, 1.1, 10).translate(0.45, 7.4, 0))
  const poleIm = new THREE.InstancedMesh(poleGeo, poleMat, poles.length)
  const armIm = new THREE.InstancedMesh(armGeo, keep(new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.6, metalness: 0.5 })), poles.length)
  const transIm = new THREE.InstancedMesh(transGeo, keep(new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.5, metalness: 0.4 })), poles.length)
  const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), zero = new THREE.Vector3(0, 0, 0)
  poles.forEach((p, k) => {
    // 腕木は道路と直角（電線の向きと直角）に
    qq.setFromAxisAngle(up, p.yaw)
    m4.compose(new THREE.Vector3(p.x, CURB_HEIGHT, p.z), qq, one)
    poleIm.setMatrixAt(k, m4)
    armIm.setMatrixAt(k, m4)
    m4.compose(new THREE.Vector3(p.x, CURB_HEIGHT, p.z), qq, k % 3 === 0 ? one : zero) // 変圧器は 3 本に 1 本
    transIm.setMatrixAt(k, m4)
  })
  for (const im of [poleIm, armIm, transIm]) { im.castShadow = true; group.add(im); own.push(im) }
  // 電線: 電柱と電柱のあいだに、たるませた線を 3 本ずつ
  const wire: number[] = []
  for (const run of map.wireRuns) {
    for (let k = 0; k + 1 < run.length; k++) {
      const [ax, az] = run[k], [bx, bz] = run[k + 1]
      const len = Math.hypot(bx - ax, bz - az)
      const nx = (bz - az) / len, nz = -(bx - ax) / len // 線に直角（腕木の方向）
      for (const off of [-0.7, 0, 0.7]) {
        const h = 8.85 + (off === 0 ? -0.9 : 0)
        let px = ax + nx * off, py = h, pz = az + nz * off
        for (let s = 1; s <= 12; s++) {
          const t = s / 12
          const x = ax + (bx - ax) * t + nx * off, z = az + (bz - az) * t + nz * off
          const y = h - Math.sin(t * Math.PI) * 0.6 // たるみ
          wire.push(px, py + CURB_HEIGHT, pz, x, y + CURB_HEIGHT, z)
          px = x; py = y; pz = z
        }
      }
    }
  }
  const wg = keep(new THREE.BufferGeometry())
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3))
  group.add(new THREE.LineSegments(wg, keep(new THREE.LineBasicMaterial({ color: 0x1a1a1a }))))

  const glows: THREE.MeshStandardMaterial[] = []
  const blinks: THREE.Object3D[] = []
  group.traverse((o) => {
    if (o.userData.glow) glows.push((o as THREE.Mesh).material as THREE.MeshStandardMaterial)
    if (o.userData.blink) blinks.push(o)
  })

  return {
    group,
    update(dt, time, night) {
      for (const g of glows) g.emissiveIntensity = night * 1.5
      const on = Math.floor(time * 1.1) % 2 === 0
      for (const b of blinks) b.visible = on
      if (fountain) {
        const pos = fountain.geometry.attributes.position as THREE.BufferAttribute
        const [ox, oy, oz] = fountain.userData.origin as number[]
        for (let k = 0; k < pos.count; k++) {
          fountainVel[k * 3 + 1] -= 9.8 * dt
          let x = pos.getX(k) + fountainVel[k * 3] * dt
          let y = pos.getY(k) + fountainVel[k * 3 + 1] * dt
          let z = pos.getZ(k) + fountainVel[k * 3 + 2] * dt
          if (y < oy - 1) { x = ox; y = oy; z = oz; fountainVel[k * 3 + 1] = 5 + Math.random() * 3 }
          pos.setXYZ(k, x, y, z)
        }
        pos.needsUpdate = true
      }
    },
    dispose() { for (const d of own) d.dispose() },
  }
}
