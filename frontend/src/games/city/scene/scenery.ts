// 街の外の景色。どれも飾りで、当たり判定はない（海の上か、はるか遠く）。
//
//   観覧車        護岸の外の桟橋に立つ。ゆっくり回り、夜はゴンドラと輪が光る
//   灯台          防波堤の先。夜は光の筋が回る
//   港のクレーン  倉庫街の側の岸壁に並ぶ（夜は赤い航空障害灯が点滅）
//   吊り橋        沖へ向かってのびる。夜は主塔とケーブルの電球が並んで光る
//   船            沖をゆっくり行き交う
//   島            水平線の島々。夜は窓の明かりが点々と光る
//   雲            空に浮かぶ大きな雲（昼は白く、夕方は赤く染まる）
//
// 夜の明かりは、本物のライトではなく「光る小さな点・面」（ブルームでにじむ）で表している。

import * as THREE from 'three'
import { SEAWALL } from '../sim/cityMap'
import type { MapConfig } from '../sim/maps'
import { makeRng, range } from '../sim/rng'
import * as TX from './textures'

export interface Scenery {
  group: THREE.Group
  update(dt: number, time: number, night: number, sunColor: THREE.Color): void
  dispose(): void
}

export function buildScenery(config: MapConfig): Scenery {
  const group = new THREE.Group()
  const rng = makeRng(config.seed ^ 0x1234)
  const own: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => { own.push(x); return x }
  const E = SEAWALL
  const steel = keep(new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.7, roughness: 0.35 }))
  const concrete = keep(new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.9 }))
  const lampMats: THREE.MeshBasicMaterial[] = []
  const lamp = (color: number) => {
    const m = keep(new THREE.MeshBasicMaterial({ color, toneMapped: false }))
    lampMats.push(m)
    m.userData.base = new THREE.Color(color)
    return m
  }

  // --- 観覧車 ---------------------------------------------------------------------
  const wheel = new THREE.Group()
  const R = 42
  const wheelPos = new THREE.Vector3(E + 55, 0, -E * 0.35)
  wheel.position.set(wheelPos.x, R + 8, wheelPos.z)
  wheel.rotation.y = Math.PI / 2
  const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(R, 0.6, 8, 96)), steel)
  const rim2 = rim.clone()
  rim.position.z = 1.6
  rim2.position.z = -1.6
  const spokes = new THREE.Group()
  const spokeGeo = keep(new THREE.CylinderGeometry(0.15, 0.15, R, 5))
  for (let k = 0; k < 32; k++) {
    for (const zz of [1.6, -1.6]) {
      const sp = new THREE.Mesh(spokeGeo, steel)
      const a = (k / 32) * Math.PI * 2
      sp.position.set(Math.cos(a) * R / 2, Math.sin(a) * R / 2, zz)
      sp.rotation.z = a - Math.PI / 2
      spokes.add(sp)
    }
  }
  const hub = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.2, 2.2, 4.5, 16).rotateX(Math.PI / 2)), steel)
  // 輪の電飾（夜に光る）
  const bulbGeo = keep(new THREE.SphereGeometry(0.35, 6, 4))
  const bulbMat = lamp(0xffe0a0)
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, 192)
  const m4 = new THREE.Matrix4()
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * Math.PI * 2
    for (const [i, zz] of [[0, 2.3], [1, -2.3]] as const) {
      m4.makeTranslation(Math.cos(a) * (R + 0.7), Math.sin(a) * (R + 0.7), zz)
      bulbs.setMatrixAt(k * 2 + i, m4)
    }
  }
  wheel.add(rim, rim2, spokes, hub, bulbs)
  // ゴンドラ（輪と一緒に回るが、いつも下を向いている）
  const gondolas: THREE.Mesh[] = []
  const gondolaColors = [0xe84a5f, 0x2a9df4, 0xf5c518, 0x3ec16f, 0xa060e0, 0xff8a3a]
  const gGeo = keep(new THREE.CapsuleGeometry(1.3, 1.2, 4, 10))
  for (let k = 0; k < 32; k++) {
    const mat = keep(new THREE.MeshStandardMaterial({ color: gondolaColors[k % gondolaColors.length], roughness: 0.3, metalness: 0.2,
      emissive: gondolaColors[k % gondolaColors.length], emissiveIntensity: 0 }))
    const g = new THREE.Mesh(gGeo, mat)
    gondolas.push(g)
    group.add(g)
  }
  // 脚と桟橋
  for (const s of [1, -1]) {
    const leg = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.8, 1.4, R + 12, 8)), steel)
    leg.position.set(wheelPos.x + s * 12, (R + 8) / 2 - 2, wheelPos.z)
    leg.rotation.z = s * 0.28
    group.add(leg)
  }
  const pier = new THREE.Mesh(keep(new THREE.BoxGeometry(90, 3, 60)), concrete)
  pier.position.set(wheelPos.x - 10, -1.2, wheelPos.z)
  group.add(wheel, pier)

  // --- 灯台 -----------------------------------------------------------------------
  const lh = new THREE.Group()
  lh.position.set(-E - 160, 0, E + 160)
  const jetty = new THREE.Mesh(keep(new THREE.BoxGeometry(8, 3, 230)), concrete)
  jetty.position.set(95, -1.2, -95)
  jetty.rotation.y = Math.PI / 4
  const towerMat = keep(new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }))
  const tower = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.4, 3.6, 26, 20)), towerMat)
  tower.position.y = 13
  const band = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.9, 3.1, 4, 20)), keep(new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.5 })))
  band.position.y = 12
  const lantern = new THREE.Mesh(keep(new THREE.CylinderGeometry(2, 2, 2.4, 12)), lamp(0xfff2c0))
  lantern.position.y = 27.4
  const cap = new THREE.Mesh(keep(new THREE.ConeGeometry(2.6, 2.4, 12)), keep(new THREE.MeshStandardMaterial({ color: 0x223, roughness: 0.4 })))
  cap.position.y = 29.8
  // 回る光の筋（半透明の細長い円錐を 2 本）
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide }))
  const beams = new THREE.Group()
  beams.position.y = 27.4
  const beamGeo = keep(new THREE.ConeGeometry(9, 260, 16, 1, true).rotateZ(Math.PI / 2).translate(130, 0, 0))
  beams.add(new THREE.Mesh(beamGeo, beamMat), new THREE.Mesh(beamGeo, beamMat).rotateY(Math.PI))
  lh.add(jetty, tower, band, lantern, cap, beams)
  group.add(lh)

  // --- 港のクレーン ---------------------------------------------------------------
  const side = config.industrial === 'none' ? 'south' : config.industrial
  const craneMat = keep(new THREE.MeshStandardMaterial({ color: 0xd5452b, roughness: 0.6, metalness: 0.3 }))
  const warn = lamp(0xff2010)
  const warnLights: THREE.Mesh[] = []
  for (let k = 0; k < 5; k++) {
    const c = new THREE.Group()
    const t = (k - 2) * 120
    const out = E + 18
    const [x, z, yaw] = side === 'south' ? [t, -out, 0] : side === 'north' ? [t, out, Math.PI]
      : side === 'west' ? [-out, t, Math.PI / 2] : [out, t, -Math.PI / 2]
    c.position.set(x, 0, z)
    c.rotation.y = yaw
    for (const lx of [-6, 6]) for (const lz of [-5, 5]) {
      const leg = new THREE.Mesh(keep(new THREE.BoxGeometry(1, 34, 1)), craneMat)
      leg.position.set(lx, 17, lz)
      c.add(leg)
    }
    const boom = new THREE.Mesh(keep(new THREE.BoxGeometry(2, 2.4, 80)), craneMat)
    boom.position.set(0, 36, -12)
    const house = new THREE.Mesh(keep(new THREE.BoxGeometry(8, 6, 10)), craneMat)
    house.position.set(0, 39, 8)
    const light = new THREE.Mesh(keep(new THREE.SphereGeometry(0.6, 8, 6)), warn)
    light.position.set(0, 43, 8)
    warnLights.push(light)
    c.add(boom, house, light)
    group.add(c)
  }
  // コンテナ船をクレーンの前に
  const hullMat = keep(new THREE.MeshStandardMaterial({ color: 0x1f2a36, roughness: 0.6 }))
  const boxColors = [0xb03a2e, 0x2e6fb0, 0x3a8a4a, 0xd0a030, 0x7a4ab0, 0xe0e0e0]
  const ships: { g: THREE.Group; r: number; a: number; w: number }[] = []
  const makeShip = (len: number, containers: boolean) => {
    const g = new THREE.Group()
    const hull = new THREE.Mesh(keep(new THREE.BoxGeometry(len * 0.16, 8, len)), hullMat)
    hull.position.y = 2
    g.add(hull)
    const bridge = new THREE.Mesh(keep(new THREE.BoxGeometry(len * 0.14, 10, 8)), keep(new THREE.MeshStandardMaterial({ color: 0xeeeeee })))
    bridge.position.set(0, 11, -len * 0.4)
    g.add(bridge)
    const win = new THREE.Mesh(keep(new THREE.BoxGeometry(len * 0.145, 1, 8.2)), lamp(0xffe6b0))
    win.position.set(0, 14, -len * 0.4)
    g.add(win)
    if (containers) {
      const cgeo = keep(new THREE.BoxGeometry(2.4, 2.6, 6))
      for (let row = 0; row < Math.floor(len / 7) - 3; row++) for (let col = -2; col <= 2; col++) for (let h = 0; h < 3; h++) {
        if (rng() < 0.2) continue
        const m = new THREE.Mesh(cgeo, keep(new THREE.MeshStandardMaterial({ color: boxColors[Math.floor(rng() * boxColors.length)], roughness: 0.7 })))
        m.position.set(col * 2.5, 7.3 + h * 2.6, -len * 0.3 + row * 6.5)
        g.add(m)
      }
    }
    // 夜の航海灯（左舷は赤、右舷は緑）
    const red = new THREE.Mesh(keep(new THREE.SphereGeometry(0.5, 6, 4)), lamp(0xff2020))
    red.position.set(len * 0.08, 7, len * 0.3)
    const green = new THREE.Mesh(keep(new THREE.SphereGeometry(0.5, 6, 4)), lamp(0x20ff40))
    green.position.set(-len * 0.08, 7, len * 0.3)
    g.add(red, green)
    group.add(g)
    return g
  }
  for (let k = 0; k < 6; k++) {
    const g = makeShip(range(rng, 70, 160), rng() < 0.7)
    ships.push({ g, r: range(rng, E + 250, E + 900), a: rng() * Math.PI * 2, w: range(rng, 0.004, 0.01) * (rng() < 0.5 ? 1 : -1) })
  }

  // --- 吊り橋 ---------------------------------------------------------------------
  const bridge = new THREE.Group()
  // 倉庫街と反対寄りの海へ、沖に向かってのばす（ローカルの +z が沖）
  const northSide = side === 'south' || side === 'north'
  bridge.position.set(northSide ? E + 40 : 0, 0, northSide ? 0 : E + 40)
  const deck = new THREE.Mesh(keep(new THREE.BoxGeometry(22, 2, 1800)), concrete)
  deck.position.set(0, 26, 900)
  bridge.add(deck)
  const cableMat = keep(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.6, roughness: 0.4 }))
  const cableBulbs: THREE.Matrix4[] = []
  for (const tz of [450, 1250]) {
    for (const tx of [-11, 11]) {
      const tower = new THREE.Mesh(keep(new THREE.BoxGeometry(3, 150, 4)), cableMat)
      tower.position.set(tx, 75, tz)
      bridge.add(tower)
    }
    const beam = new THREE.Mesh(keep(new THREE.BoxGeometry(25, 4, 4)), cableMat)
    beam.position.set(0, 140, tz)
    bridge.add(beam)
  }
  // 主ケーブル（放物線を細い円柱でつなぐ）
  const catenary = (z0: number, z1: number, h0: number, h1: number, sag: number) => {
    const pts: THREE.Vector3[] = []
    for (let k = 0; k <= 40; k++) {
      const t = k / 40
      pts.push(new THREE.Vector3(0, h0 + (h1 - h0) * t - sag * 4 * t * (1 - t), z0 + (z1 - z0) * t))
    }
    return pts
  }
  for (const tx of [-11, 11]) {
    for (const [z0, z1, h0, h1, sag] of [[0, 450, 28, 150, 30], [450, 1250, 150, 150, 115], [1250, 1800, 150, 28, 30]]) {
      const pts = catenary(z0, z1, h0, h1, sag)
      const tube = new THREE.Mesh(keep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.5, 5)), cableMat)
      tube.position.x = tx
      bridge.add(tube)
      for (let k = 0; k < pts.length; k += 2) cableBulbs.push(new THREE.Matrix4().makeTranslation(tx, pts[k].y + 0.8, pts[k].z))
    }
  }
  const cb = new THREE.InstancedMesh(bulbGeo, lamp(0xfff6d8), cableBulbs.length)
  cableBulbs.forEach((m, k) => cb.setMatrixAt(k, m))
  bridge.add(cb)
  bridge.rotation.y = northSide ? Math.PI / 2 : 0
  group.add(bridge)

  // --- 島と夜景 ---------------------------------------------------------------------
  const islandMat = keep(new THREE.MeshStandardMaterial({ color: 0x34443a, roughness: 1, flatShading: true }))
  const cityLights: THREE.Matrix4[] = []
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + range(rng, -0.2, 0.2)
    const r = range(rng, 1500, 2100)
    const w = range(rng, 150, 420)
    const isl = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)), islandMat)
    isl.position.set(Math.sin(a) * r, -3, Math.cos(a) * r)
    isl.scale.set(w, range(rng, 25, 90), w * range(rng, 0.5, 1))
    group.add(isl)
    for (let n = 0; n < 60; n++) {
      const aa = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * w * 0.8
      cityLights.push(new THREE.Matrix4().makeTranslation(isl.position.x + Math.sin(aa) * rr, 2 + rng() * 8, isl.position.z + Math.cos(aa) * rr))
    }
  }
  const lightsMesh = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(1.4, 4, 3)), lamp(0xffd28a), cityLights.length)
  cityLights.forEach((m, k) => lightsMesh.setMatrixAt(k, m))
  group.add(lightsMesh)

  // --- 雲 ---------------------------------------------------------------------------
  const cloudTex = keep(TX.smokePuff())
  const cloudMat = keep(new THREE.SpriteMaterial({ map: cloudTex, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, fog: false }))
  const clouds = new THREE.Group()
  for (let k = 0; k < 40; k++) {
    const a = rng() * Math.PI * 2, r = range(rng, 400, 2600)
    const cx = Math.sin(a) * r, cz = Math.cos(a) * r, cy = range(rng, 350, 700)
    for (let n = 0; n < 6; n++) {
      const s = new THREE.Sprite(cloudMat)
      s.position.set(cx + range(rng, -120, 120), cy + range(rng, -20, 30), cz + range(rng, -120, 120))
      const sz = range(rng, 150, 320)
      s.scale.set(sz, sz * 0.55, 1)
      clouds.add(s)
    }
  }
  group.add(clouds)

  let blink = 0
  return {
    group,
    update(dt, time, night, sunColor) {
      // 観覧車: ゆっくり回り、ゴンドラはいつも下向き
      wheel.rotation.x = 0
      const rot = time * 0.02
      spokes.rotation.z = rot
      rim.rotation.z = rot
      rim2.rotation.z = rot
      bulbs.rotation.z = rot
      gondolas.forEach((g, k) => {
        const a = (k / 32) * Math.PI * 2 + rot
        g.position.set(wheelPos.x, R + 8 + Math.sin(a) * R - 2.4, wheelPos.z - Math.cos(a) * R)
        ;(g.material as THREE.MeshStandardMaterial).emissiveIntensity = night * 1.2
      })
      // 灯台の光
      beams.rotation.y = time * 0.9
      beamMat.opacity = night * 0.16
      // 夜の明かり（昼は消す）
      for (const m of lampMats) m.color.copy(m.userData.base as THREE.Color).multiplyScalar(0.05 + night * 2.2)
      blink += dt
      const on = Math.floor(blink * 1.2) % 2 === 0
      for (const w of warnLights) w.visible = on || night < 0.3
      // 船
      for (const s of ships) {
        s.a += s.w * dt
        s.g.position.set(Math.sin(s.a) * s.r, -1.5, Math.cos(s.a) * s.r)
        s.g.rotation.y = s.a + (s.w > 0 ? Math.PI / 2 : -Math.PI / 2)
      }
      // 雲は空の色に染まる
      cloudMat.color.copy(sunColor).lerp(new THREE.Color(0x202634), night * 0.85)
      cloudMat.opacity = 0.75 - night * 0.45
      clouds.rotation.y += dt * 0.002
    },
    dispose() {
      for (const d of own) d.dispose()
      bulbs.dispose(); cb.dispose(); lightsMesh.dispose()
    },
  }
}
