// three.js の場面（シーン）の組み立てと、毎フレームの更新。React には依存しない。
//
// 役割分担:
//   sim/       誰がどこにいるか（ルール）
//   scene/     それをどう見せるか  ← ここ
//   OceanCanvas.tsx  canvas を置いて、この場面を毎フレーム回す
//
// カメラは泳ぐ人の後ろ上から追いかける。潜ると一緒に水に入り、霧と空の色を水中のものに切り替える。
// 区間（浅瀬 → 沖合 → 夜の海）が変わると、色は themes.ts の値へ数秒かけてじわっと寄せる。

import * as THREE from 'three'
import { type GameEvent, MAX_DEPTH, type OceanGame } from '../sim/game'
import { zoneAt } from '../sim/zones'
import { buildJelly, buildPearl, buildShark, disposeShared, FishSchools, type JellyModel, type PearlModel,
         setJellyGlow, type SharkModel } from './creatures'
import { Decor } from './decor'
import { BLOOD_COLOR, Particles, PEARL_COLOR, STING_COLOR } from './effects'
import { buildSwimmer, type SwimmerModel } from './swimmer'
import { themeFor, type Theme } from './themes'
import { Underwater } from './underwater'
import { buildFloor, buildWater, type Floor, type Water, waveHeight } from './water'
import { buildWorld, type World } from './world'

const CAM_BACK = 7.5 // 泳ぐ人の後ろ何 m から見るか
const CAM_BACK_UNDER = 6.0 // 水中では少し近づく（体が見えて、まわりも広く見える）
const CAM_UP = 2.9
const CAM_LOOK = 9 // 何 m 先を見るか
const CAM_SMOOTH = 6
const FOV_BASE = 62
const FOV_UNDER = 74 // 水中では画角を広げる（潜っている感じが出る）
const FOV_DASH = 8
const THEME_SPEED = 0.5 // 区間の色が切り替わる速さ（大きいほど早い）

/** 区間の色を「今の値」として持つ（目標の Theme へ毎フレーム寄せる） */
class LiveTheme {
  skyTop = new THREE.Color()
  skyBottom = new THREE.Color()
  waterDeep = new THREE.Color()
  waterShallow = new THREE.Color()
  fogAir = new THREE.Color()
  fogAirFar = 400
  fogWater = new THREE.Color()
  fogWaterFar = 60
  floor = new THREE.Color()
  /** 海底の深さ（sim/zones.ts の floorY をなめらかに追う） */
  floorY = -16
  sunColor = new THREE.Color()
  sunStrength = 2
  ambient = new THREE.Color()
  ambientStrength = 1
  sunDir = new THREE.Vector3()
  jellyGlow = 0.5
  stars = 0

  set(t: Theme): void {
    this.skyTop.set(t.skyTop); this.skyBottom.set(t.skyBottom)
    this.waterDeep.set(t.waterDeep); this.waterShallow.set(t.waterShallow)
    this.fogAir.set(t.fogAir); this.fogAirFar = t.fogAirFar
    this.fogWater.set(t.fogWater); this.fogWaterFar = t.fogWaterFar
    this.floor.set(t.floor)
    this.sunColor.set(t.sunColor); this.sunStrength = t.sunStrength
    this.ambient.set(t.ambient); this.ambientStrength = t.ambientStrength
    this.sunDir.set(...t.sunDir).normalize()
    this.jellyGlow = t.jellyGlow
    this.stars = t.stars ? 1 : 0
  }

  private tmpColor = new THREE.Color()
  private tmpVec = new THREE.Vector3()

  lerpTo(t: Theme, k: number): void {
    const c = (cur: THREE.Color, target: number) => cur.lerp(this.tmpColor.set(target), k)
    const n = (cur: number, target: number) => cur + (target - cur) * k
    c(this.skyTop, t.skyTop); c(this.skyBottom, t.skyBottom)
    c(this.waterDeep, t.waterDeep); c(this.waterShallow, t.waterShallow)
    c(this.fogAir, t.fogAir); this.fogAirFar = n(this.fogAirFar, t.fogAirFar)
    c(this.fogWater, t.fogWater); this.fogWaterFar = n(this.fogWaterFar, t.fogWaterFar)
    c(this.floor, t.floor)
    c(this.sunColor, t.sunColor); this.sunStrength = n(this.sunStrength, t.sunStrength)
    c(this.ambient, t.ambient); this.ambientStrength = n(this.ambientStrength, t.ambientStrength)
    this.sunDir.lerp(this.tmpVec.set(...t.sunDir).normalize(), k).normalize()
    this.jellyGlow = n(this.jellyGlow, t.jellyGlow)
    this.stars = n(this.stars, t.stars ? 1 : 0)
  }
}

export class OceanScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private water: Water
  private floor: Floor
  private world: World
  private swimmer: SwimmerModel
  private particles = new Particles()
  private fish = new FishSchools()
  private decor: Decor
  private jellies = new Map<number, JellyModel>()
  private sharks = new Map<number, SharkModel>()
  private pearls = new Map<number, PearlModel>()
  private live = new LiveTheme()
  private underwater = new Underwater()
  private fog = new THREE.Fog(0xffffff, 1, 100)
  private fogColor = new THREE.Color()
  private time = 0
  private camPos = new THREE.Vector3()
  private camAim = new THREE.Vector3()
  private started = false
  private shake = 0
  private bubbleTimer = 0
  private tmp = new THREE.Vector3()
  /** カメラが水の中にあるか（HUD の色合いに使う） */
  cameraUnderwater = false

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.camera = new THREE.PerspectiveCamera(FOV_BASE, 16 / 9, 0.2, 1500)
    this.scene.fog = this.fog

    this.water = buildWater()
    this.floor = buildFloor()
    this.world = buildWorld()
    this.swimmer = buildSwimmer()
    this.decor = new Decor((z) => {
      const floorY = zoneAt(z).floorY
      return floorY > -24 ? floorY : null // 海底が見えない区間には置かない
    })
    this.scene.add(this.world.group, this.floor.mesh, this.decor.group, this.fish.mesh,
                   this.swimmer.group, this.particles.points, this.underwater.group, this.water.mesh)
    this.live.set(themeFor('shallow'))
    this.live.floorY = zoneAt(0).floorY
    this.resize()
  }

  /** 出来事に合わせた演出（画面の揺れ・粒） */
  handleEvents(events: GameEvent[]): void {
    for (const ev of events) {
      const x = ev.x ?? 0, y = ev.y ?? 0, z = ev.z ?? 0
      switch (ev.kind) {
        case 'bite':
          this.shake = 1
          this.particles.burst(x, y, z, BLOOD_COLOR, 40, 3)
          this.particles.splash(x, Math.max(y, waveHeight(x, z, this.time)), z, 30, 1.6)
          break
        case 'sting':
          this.shake = Math.max(this.shake, 0.35)
          this.particles.burst(x, y, z, STING_COLOR, 24, 2.2)
          break
        case 'pearl':
          this.particles.burst(x, y, z, PEARL_COLOR, 20, 1.6)
          break
        case 'punch':
          this.shake = Math.max(this.shake, 0.5)
          this.particles.splash(x, Math.max(y, waveHeight(x, z, this.time)), z, 40, 1.8)
          break
        case 'submerge':
        case 'surface':
          this.particles.splash(x, waveHeight(x, z, this.time), z, 18, 1.1)
          break
        case 'dead':
          this.shake = 0.8
          break
      }
    }
  }

  update(dt: number, game: OceanGame): void {
    this.time += dt
    const p = game.player
    const t = this.time

    // --- 区間の色 -----------------------------------------------------------
    this.live.lerpTo(themeFor(game.zone.id), 1 - Math.exp(-dt * THEME_SPEED))
    const L = this.live
    L.floorY += (game.zone.floorY - L.floorY) * (1 - Math.exp(-dt * THEME_SPEED))
    setJellyGlow(L.jellyGlow)

    // --- 泳ぐ人 -------------------------------------------------------------
    const wave = waveHeight(p.x, p.z, t)
    const surfaceK = THREE.MathUtils.clamp(1 + p.y / 2, 0, 1) // 海面付近でだけ波に乗る
    this.swimmer.group.position.set(p.x, p.y - 0.12 + wave * 0.9 * surfaceK, p.z)
    const stroke = this.swimmer.update(dt, {
      speed: p.speed, effort: p.dashing ? 1 : 0.2, vy: p.vy,
      stunned: p.stun > 0, kick: p.kickAnim, underwater: game.underwater,
    })
    if (stroke) {
      const side = Math.random() < 0.5 ? 0 : 1
      this.swimmer.handWorld(side, this.tmp)
      this.particles.splash(this.tmp.x, waveHeight(this.tmp.x, this.tmp.z, t), this.tmp.z, p.dashing ? 12 : 6, p.dashing ? 1.2 : 0.8)
    }
    if (game.underwater) {
      this.bubbleTimer -= dt
      if (this.bubbleTimer <= 0) {
        this.bubbleTimer = p.dashing ? 0.06 : 0.14
        this.swimmer.headWorld(this.tmp)
        this.particles.bubble(this.tmp.x, this.tmp.y, this.tmp.z, p.dashing ? 3 : 1)
      }
    } else if (p.dashing) {
      // ダッシュ中は脚の水しぶき
      this.particles.splash(p.x, wave, p.z - 0.8, 2, 0.7)
    }

    // --- クラゲ・真珠・サメ ------------------------------------------------
    const seen = new Set<number>()
    for (const j of game.jellies) {
      seen.add(j.id)
      let m = this.jellies.get(j.id)
      if (!m) { m = buildJelly(j.kind, j.size); this.jellies.set(j.id, m); this.scene.add(m.group) }
      m.group.position.set(j.x, j.y, j.z)
      m.update(t, j.phase)
    }
    for (const [id, m] of this.jellies) if (!seen.has(id)) { this.scene.remove(m.group); m.dispose(); this.jellies.delete(id) }

    seen.clear()
    for (const q of game.pearls) {
      seen.add(q.id)
      let m = this.pearls.get(q.id)
      if (!m) { m = buildPearl(); this.pearls.set(q.id, m); this.scene.add(m.group) }
      const bob = q.y > -0.5 ? waveHeight(q.x, q.z, t) * 0.8 : 0
      m.group.position.set(q.x, q.y + bob, q.z)
      m.update(t, q.phase)
    }
    for (const [id, m] of this.pearls) if (!seen.has(id)) { this.scene.remove(m.group); m.dispose(); this.pearls.delete(id) }

    seen.clear()
    for (const s of game.sharks) {
      seen.add(s.id)
      let m = this.sharks.get(s.id)
      if (!m) { m = buildShark(); this.sharks.set(s.id, m); this.scene.add(m.group) }
      m.group.position.set(s.x, s.y, s.z)
      m.group.rotation.set(0, s.yaw, 0)
      m.update(dt, s.speed, s.state === 'charge')
      // 背びれが海面を切っているときは、しぶきを引く
      m.finWorld(this.tmp)
      const sea = waveHeight(this.tmp.x, this.tmp.z, t)
      if (this.tmp.y > sea - 0.3 && s.speed > 2) {
        this.particles.splash(this.tmp.x, sea, this.tmp.z - 0.5, 2, 0.5 + s.speed * 0.04)
      }
    }
    for (const [id, m] of this.sharks) if (!seen.has(id)) { this.scene.remove(m.group); m.dispose(); this.sharks.delete(id) }

    // --- 景色 ---------------------------------------------------------------
    this.water.mesh.position.set(p.x, 0, p.z)
    this.floor.mesh.position.set(p.x, L.floorY, p.z)
    this.decor.update(t, p.z)
    this.fish.update(t, p.x, p.z, L.floorY)
    this.particles.update(dt, (x, z) => waveHeight(x, z, t))

    // --- カメラ -------------------------------------------------------------
    // 潜ると一緒に水に入る（海面の近くでちらつかないよう、深さに応じてなめらかに下げる）
    const dive = THREE.MathUtils.smoothstep(-p.y, 0.6, 2.6) // 0 = 海面, 1 = 潜っている
    const camY = p.y + CAM_UP * (1 - dive) + 1.2 * dive
    const wantPos = this.tmp.set(p.x, camY, p.z - (CAM_BACK * (1 - dive) + CAM_BACK_UNDER * dive))
    if (this.shake > 0) {
      wantPos.x += (Math.random() - 0.5) * this.shake * 0.8
      wantPos.y += (Math.random() - 0.5) * this.shake * 0.6
      this.shake = Math.max(0, this.shake - dt * 2.2)
    }
    const wantAim = new THREE.Vector3(p.x, p.y + 0.3 - dive * 0.6, p.z + CAM_LOOK)
    if (!this.started) {
      this.camPos.copy(wantPos); this.camAim.copy(wantAim); this.started = true
    } else {
      this.camPos.x = THREE.MathUtils.damp(this.camPos.x, wantPos.x, CAM_SMOOTH, dt)
      this.camPos.y = THREE.MathUtils.damp(this.camPos.y, wantPos.y, CAM_SMOOTH, dt)
      this.camPos.z = THREE.MathUtils.damp(this.camPos.z, wantPos.z, CAM_SMOOTH * 1.5, dt)
      this.camAim.lerp(wantAim, Math.min(1, dt * CAM_SMOOTH * 1.4))
    }
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.camAim)
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, FOV_BASE + (FOV_UNDER - FOV_BASE) * dive + (p.dashing ? FOV_DASH : 0), 4, dt)
    this.camera.updateProjectionMatrix()

    // --- 霧と空（カメラが水の中かどうかで切り替える） ----------------------
    const under = this.camera.position.y < waveHeight(this.camera.position.x, this.camera.position.z, t)
    this.cameraUnderwater = under
    const depthK = under ? THREE.MathUtils.clamp(-this.camera.position.y / -MAX_DEPTH, 0, 1) : 0
    if (under) {
      // 深く潜るほど光が届かず、暗く・近くまでしか見えなくなる
      this.fogColor.copy(L.fogWater).multiplyScalar(1 - depthK * 0.5)
      this.fog.color.copy(this.fogColor)
      this.fog.near = 1.5
      this.fog.far = L.fogWaterFar * (1 - depthK * 0.4)
      this.world.sky.top.value.copy(this.fogColor)
      this.world.sky.bottom.value.copy(this.fogColor)
      this.world.sunDisc.visible = false
    } else {
      this.fog.color.copy(L.fogAir)
      this.fog.near = 30
      this.fog.far = L.fogAirFar
      this.world.sky.top.value.copy(L.skyTop)
      this.world.sky.bottom.value.copy(L.skyBottom)
      this.world.sunDisc.visible = true
    }
    const wu = this.water.uniforms
    wu.time.value = t
    wu.deep.value.copy(L.waterDeep)
    wu.shallow.value.copy(L.waterShallow)
    wu.sky.value.copy(L.skyBottom)
    wu.sunDir.value.copy(L.sunDir)
    wu.sunColor.value.copy(L.sunColor)
    wu.sunStrength.value = L.sunStrength / 2.6
    wu.fogColor.value.copy(this.fog.color)
    wu.fogNear.value = under ? 1.5 : 20
    wu.fogFar.value = this.fog.far
    const fu = this.floor.uniforms
    fu.time.value = t
    fu.color.value.copy(L.floor)
    fu.sunDir.value.copy(L.sunDir)
    fu.caustic.value = THREE.MathUtils.clamp((L.floorY + 30) / 14, 0, 1) * (L.sunStrength / 2.6)
    fu.fogColor.value.copy(under ? this.fogColor : L.fogWater)
    fu.fogNear.value = 2
    fu.fogFar.value = (under ? this.fog.far : L.fogWaterFar) * 1.3

    // 水中の演出（光の筋・漂う粒）
    this.underwater.update(dt, this.camera.position, p.x, p.z, L.sunDir, under, depthK,
                           Math.min(1, L.sunStrength / 2.6), (x, z) => waveHeight(x, z, t))

    // 光と太陽
    this.world.group.position.copy(this.camera.position)
    this.world.sun.color.copy(L.sunColor)
    this.world.sun.intensity = L.sunStrength * (under ? 0.7 * (1 - depthK * 0.55) : 1)
    this.world.sun.position.copy(L.sunDir).multiplyScalar(200)
    this.world.hemi.color.copy(L.ambient)
    this.world.hemi.groundColor.copy(L.waterDeep)
    this.world.hemi.intensity = L.ambientStrength * (1 - depthK * 0.35)
    this.world.sunDisc.position.copy(L.sunDir).multiplyScalar(820)
    this.world.sunDisc.lookAt(this.camera.position)
    // 夜は太陽の円盤が月になる（色をテーマの光の色に寄せ、少し暗く）
    const disc = this.world.sunDisc.material as THREE.MeshBasicMaterial
    disc.color.copy(L.sunColor)
    disc.opacity = 0.6 + 0.4 * Math.min(1, L.sunStrength / 2.6)
    ;(this.world.stars.material as THREE.PointsMaterial).opacity = L.stars

    this.renderer.render(this.scene, this.camera)
  }

  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth || 960
    const h = canvas.clientHeight || 540
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.particles.resize(h)
  }

  dispose(): void {
    for (const m of this.jellies.values()) m.dispose()
    for (const m of this.sharks.values()) m.dispose()
    for (const m of this.pearls.values()) m.dispose()
    this.swimmer.dispose()
    this.particles.dispose()
    this.underwater.dispose()
    this.fish.dispose()
    this.decor.dispose()
    this.water.dispose()
    this.floor.dispose()
    this.world.dispose()
    disposeShared()
    this.renderer.dispose()
  }
}
