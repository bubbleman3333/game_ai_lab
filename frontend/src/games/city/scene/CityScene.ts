// three.js の場面の組み立てと、毎フレームの更新。React には依存しない。
//
//   sim/     どこに何がいるか（計算）
//   scene/   それをどう見せるか ← ここ
//
// 見た目をリアルにするために使っているもの:
//   空        Sky シェーダー（大気の散乱で、昼・夕焼け・夜の色が太陽の高さから自然に決まる）
//   映り込み  その空から作った環境マップ（PMREM）。車の塗装・ガラス・濡れた路面に空が映る
//   光        太陽（影つき）＋空の明るさ。夜は月明かり、窓・街灯・ヘッドライトが光る
//   仕上げ    ACES のトーンマッピングと、明るいところがにじむブルーム
//
// カメラは車の後ろから追いかけ、建物にめり込みそうなら手前に寄る。

import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CURB_HEIGHT } from '../sim/cityMap'
import type { Game, GameEvent, Vehicle } from '../sim/game'
import { MARKER_RADIUS } from '../sim/missions'
import { speedOf } from '../sim/vehicle'
import { buildCity, type CityModel } from './buildCity'
import { buildCarModel, setCarNight, type CarModel } from './carModels'
import { Effects } from './effects'
import { PedModels } from './pedModels'
import { PedSkinned } from './pedSkinned'
import { buildHeli, type HeliModel } from './heliModel'
import { buildScenery, type Scenery } from './scenery'
import { loadPhotos } from './photoTextures'
import { Plants } from './plants'
import { buildLandmarks, type Landmarks } from './landmarks'
import * as TX from './textures'
import { THEMES, type CityTheme } from './themes'

export type Quality = 'high' | 'low'

/** カメラの種類: 遠め・近め・ボンネット */
export const CAMERA_MODES = ['遠め', '近め', 'ボンネット'] as const
const CAM = [
  { back: 9.5, up: 3.6, look: 10 },
  { back: 6.3, up: 2.3, look: 8 },
  { back: -0.6, up: 1.25, look: 20 },
]

interface CarView {
  model: CarModel
  vehicle: Vehicle
  roll: number
  pitch: number
  bounce: number
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

export class CityScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer | null = null
  private bloom: UnrealBloomPass | null = null
  private city: CityModel
  private scenery: Scenery
  private heli: HeliModel | null = null
  private disposers: (() => void)[] = []
  /** 植え込みの低木（写真スキャンのモデル） */
  private plants: Plants
  /** 電波塔・神社・池・電柱 */
  private landmarks: Landmarks
  /** 壊した店の跡（ガラスの割れた店内の絵・散らばった商品） */
  private smashedShown = 0
  private smashTex = TX.smashedShop()
  private smashMat = new THREE.MeshStandardMaterial({ map: this.smashTex, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4 })
  private smashGeo = new THREE.PlaneGeometry(3.8, 3.4)
  private goodsGeo = new THREE.BoxGeometry(0.35, 0.25, 0.3)
  private goodsMat = new THREE.MeshStandardMaterial({ roughness: 0.6 })
  private smashGroup = new THREE.Group()
  private theme: CityTheme
  private cars = new Map<number, CarView>()
  private peds = new PedModels()
  /** 近くの人は骨格つきの人のモデルで描く */
  private skinned = new PedSkinned()
  private effects: Effects
  private sky = new Sky()
  private skyScene = new THREE.Scene()
  private pmrem: THREE.PMREMGenerator
  private envRT: THREE.WebGLRenderTarget | null = null
  private lastEnvClock = -99
  private sun = new THREE.DirectionalLight(0xffffff, 3)
  private hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a4036, 0.8)
  private headlight = new THREE.SpotLight(0xfff1dc, 0, 80, 0.55, 0.55, 1.4)
  private copLights = [new THREE.PointLight(0xff2020, 0, 26, 1.6), new THREE.PointLight(0x2040ff, 0, 26, 1.6)]
  private stars: THREE.Points
  private markers: THREE.Group = new THREE.Group()
  private markerMeshes: THREE.Mesh[] = []
  private beamGeo: THREE.CylinderGeometry
  private ringGeo: THREE.CylinderGeometry
  private arrow: THREE.Mesh
  private glowTex: THREE.Texture
  private camPos = new THREE.Vector3()
  private camAim = new THREE.Vector3()
  private camInit = false
  private shake = 0
  private time = 0
  private night = 0
  cameraMode = 0
  /** マウスで回した分（ラジアン） */
  orbit = 0
  lookBack = false
  private sunDir = new THREE.Vector3()
  private game: Game

  constructor(canvas: HTMLCanvasElement, game: Game, quality: Quality) {
    this.game = game
    this.theme = THEMES[game.config.theme]
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' })
    // 高画質は画面の実際の細かさ（Retina なら 2 倍）で描く
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1))
    this.renderer.shadowMap.enabled = quality === 'high'
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.6
    this.pmrem = new THREE.PMREMGenerator(this.renderer)

    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 4200)
    this.scene.fog = new THREE.FogExp2(this.theme.haze, this.theme.fog)

    // 空
    this.sky.scale.setScalar(4000)
    const u = this.sky.material.uniforms
    u.turbidity.value = this.theme.turbidity
    u.rayleigh.value = this.theme.rayleigh
    u.mieCoefficient.value = this.theme.mie
    u.mieDirectionalG.value = 0.8
    this.scene.add(this.sky)

    // 星
    const starPos: number[] = []
    for (let k = 0; k < 2500; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.acos(Math.random() * 0.95)
      starPos.push(Math.sin(e) * Math.sin(a) * 3500, Math.cos(e) * 3500, Math.sin(e) * Math.cos(a) * 3500)
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3))
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }))
    this.scene.add(this.stars)

    // 光
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(quality === 'high' ? 4096 : 1024, quality === 'high' ? 4096 : 1024)
    const sc = this.sun.shadow.camera
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 1; sc.far = 600
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.04
    this.scene.add(this.sun, this.sun.target, this.hemi, this.headlight, this.headlight.target, ...this.copLights)

    this.city = buildCity(game.map, this.theme)
    this.scenery = buildScenery(game.config)
    this.plants = new Plants(game.map, new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.85 }))
    this.scene.add(this.plants.group)
    this.landmarks = buildLandmarks(game.map)
    this.scene.add(this.landmarks.group)
    // 写真のテクスチャは読み込めしだい差し替える（読み込み中も遊べる）
    const city = this.city
    let alive = true
    this.disposers.push(() => { alive = false })
    void loadPhotos(this.renderer.capabilities.getMaxAnisotropy()).then((ph) => { if (alive) city.applyPhotos(ph) })
      .catch((e) => console.warn('写真テクスチャを読み込めなかった', e))
    this.scene.add(this.city.group, this.scenery.group, this.smashGroup)
    this.effects = new Effects(this.theme.weather)
    this.scene.add(this.peds.group, this.skinned.group, this.effects.group, this.markers)
    this.skinned.load()
    this.glowTex = TX.softDot(128, 1.3)

    // ミッションの輪（光の筒）と、標的の上の矢印
    this.beamGeo = new THREE.CylinderGeometry(0.9, 0.9, 120, 16, 1, true)
    this.beamGeo.translate(0, 60, 0)
    this.ringGeo = new THREE.CylinderGeometry(MARKER_RADIUS, MARKER_RADIUS, 2.2, 40, 1, true)
    this.ringGeo.translate(0, 1.1, 0)
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.6, 4).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xff3030, toneMapped: false }))
    this.arrow.visible = false
    this.scene.add(this.arrow)

    if (quality === 'high') {
      // ブルームのために一度別の画像へ描くと、ふつうはアンチエイリアス（ギザギザ消し）が効かなくなる。
      // 描き先を MSAA（4 倍のサンプル）つきにして、輪郭がなめらかなままにする
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
      this.composer = new EffectComposer(this.renderer, target)
      this.composer.addPass(new RenderPass(this.scene, this.camera))
      this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.4, 0.5, 0.85)
      this.composer.addPass(this.bloom)
      this.composer.addPass(new OutputPass())
    }
    this.resize()
  }

  resize(): void {
    const c = this.renderer.domElement
    const w = c.clientWidth || window.innerWidth
    const h = c.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.effects.setPixelScale(h * Math.min(window.devicePixelRatio, 1.75))
  }

  // --- 時刻と光 ----------------------------------------------------------------------

  private updateSky(clock: number): void {
    // 6 時に日の出、18 時に日の入り。太陽は東（+x）から昇って西へ
    const t = ((clock - 6) / 12) * Math.PI
    const elev = Math.sin(t) * 62 // 度
    const az = (clock / 24) * Math.PI * 2 + 0.6
    const phi = THREE.MathUtils.degToRad(90 - elev)
    this.sunDir.setFromSphericalCoords(1, phi, az)
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir)
    this.night = smooth(3, -9, elev)
    const n = this.night
    const lowSun = smooth(25, 2, elev) * (1 - n)

    // 太陽（夜は月の光として、高いところから青白く）
    const moon = n > 0.5
    const dir = moon ? new THREE.Vector3(-0.4, 0.8, 0.45).normalize() : this.sunDir
    this.sun.intensity = moon ? 0.35 * n : 3.2 * (1 - n) * (0.35 + 0.65 * smooth(0, 20, elev))
    this.sun.color.setRGB(1, 1 - lowSun * 0.35, 1 - lowSun * 0.6)
    if (moon) this.sun.color.setRGB(0.62, 0.72, 1)
    this.sunLight = dir
    this.hemi.intensity = 0.25 + (1 - n) * 0.75
    this.hemi.color.setRGB(0.72 - n * 0.5, 0.8 - n * 0.55, 1 - n * 0.55)
    this.hemi.groundColor.setRGB(0.3 - n * 0.2, 0.26 - n * 0.18, 0.22 - n * 0.14)
    this.renderer.toneMappingExposure = 0.55 + n * 0.35
    ;(this.stars.material as THREE.PointsMaterial).opacity = this.theme.weather === 'clear' ? n : n * 0.2

    // 霧: 昼は街の空気の色、夕方は赤み、夜は暗い青
    const fog = this.scene.fog as THREE.FogExp2
    const day = new THREE.Color(this.theme.haze)
    const dusk = new THREE.Color(0xd08a5a)
    const nightC = new THREE.Color(this.theme.weather === 'clear' ? 0x0a0f1c : 0x14171e)
    fog.color.copy(day).lerp(dusk, lowSun * 0.6).lerp(nightC, n)
    fog.density = this.theme.fog * (1 + n * 0.3)

    this.city.setNight(n)
    setCarNight(n, this.glowTex)
    if (this.bloom) {
      // 昼は控えめ（白線や壁までにじむので）、夜は街の明かりがにじむように
      // にじませる明るさの境目はトーンマッピング前の明るさ。昼の日なたは 2〜3 あるので、
      // 昼は境目を高くして（太陽の映り込みなど本当に強い光だけ）、夜は街の明かりがにじむように下げる
      this.bloom.strength = 0.1 + n * 0.8
      this.bloom.threshold = 3.5 - n * 2.75
    }

    // 空が大きく変わったら映り込みを作り直す（毎フレームは重いので間引く）
    if (Math.abs(clock - this.lastEnvClock) > 0.2) {
      this.lastEnvClock = clock
      this.skyScene.add(this.sky)
      this.envRT?.dispose()
      this.envRT = this.pmrem.fromScene(this.skyScene, 0, 1, 5000)
      this.scene.add(this.sky)
      this.scene.environment = this.envRT.texture
      this.scene.environmentIntensity = 0.25 + (1 - n) * 0.75
    }
  }
  private sunLight = new THREE.Vector3(0, 1, 0)

  // --- 車 --------------------------------------------------------------------------------

  private syncCars(dt: number): void {
    const seen = new Set<number>()
    for (const v of this.game.vehicles) {
      seen.add(v.id)
      let view = this.cars.get(v.id)
      if (!view) {
        const model = buildCarModel(v.spec.type, v.color)
        this.scene.add(model.group)
        view = { model, vehicle: v, roll: 0, pitch: 0, bounce: 0 }
        this.cars.set(v.id, view)
      }
      this.updateCar(view, dt)
    }
    for (const [id, view] of this.cars) {
      if (seen.has(id)) continue
      this.scene.remove(view.model.group)
      view.model.dispose()
      this.cars.delete(id)
    }
  }

  private updateCar(view: CarView, dt: number): void {
    const { model, vehicle: v } = view
    const b = v.body
    model.group.position.set(b.x, b.y, b.z)
    model.group.rotation.y = b.yaw
    // 車体の傾き: ブレーキで前が沈み、曲がると外側へ傾く（ばねのように遅れてついてくる）
    const k = Math.min(1, dt * 7)
    view.pitch += (Math.max(-0.07, Math.min(0.07, -b.accLong * 0.009)) - view.pitch) * k
    view.roll += (Math.max(-0.09, Math.min(0.09, -b.accLat * 0.011)) - view.roll) * k
    model.body.rotation.set(view.pitch, 0, view.roll)
    model.body.position.y = view.bounce
    view.bounce *= Math.exp(-dt * 6)
    while (model.dentCount < v.dents.length) {
      const d = v.dents[model.dentCount++]
      model.dent(d.x, d.z, d.k)
    }
    // へこみが深くまとまった（同じ場所に何度もぶつけた）ら、ガラスごと抜け落ちる
    if (model.glass.visible && v.dents.some((d) => d.k > 1.1)) {
      model.glass.visible = false
      this.effects.glass(b.x, 1.2, b.z, 60, b.vx, b.vz)
    }
    for (const w of model.wheels) w.rotation.x = b.wheelSpin
    for (const p of model.frontPivots) p.rotation.y = -b.steer

    const n = this.night
    model.tail.emissiveIntensity = v.braking ? 3 : 0.25 + n * 1.2
    if (model.siren) {
      const on = v.siren && Math.floor(this.time * 7 + v.id) % 2 === 0
      model.siren[0].color.setRGB(on ? 4 : 0.2, 0, 0)
      model.siren[1].color.setRGB(0, 0, !on && v.siren ? 4 : 0.2)
    }
    if (v.hazard && !v.wrecked) {
      const on = Math.floor(this.time * 2.5) % 2 === 0
      model.tail.emissiveIntensity = on ? 2.4 : 0.2
    }
    // 壊れ具合: 塗装が傷んでくすみ、爆発したら黒こげ
    const dmg = 1 - v.health / v.spec.hp
    model.paint.roughness = 0.32 + dmg * 0.4
    model.paint.clearcoat = 1 - dmg * 0.8
    if (v.wrecked && model.glass.visible) {
      model.glass.visible = false
      model.paint.color.setHex(0x1b1714)
      model.paint.metalness = 0.2
      model.paint.roughness = 0.9
      model.paint.clearcoat = 0
    }

    // 煙・火
    const hood = model.profile.length / 2 - 0.9
    const hx = b.x + Math.sin(b.yaw) * hood, hz = b.z + Math.cos(b.yaw) * hood
    if (v.burning >= 0 || v.wrecked) {
      if (Math.random() < 0.7) this.effects.fire(hx, 1.1, hz)
    } else if (dmg > 0.55 && Math.random() < dmg * 0.4) {
      this.effects.engineSmoke(hx, 1.1, hz, dmg)
    }

    // タイヤ痕とタイヤの煙（後輪）
    if (!v.lane && b.slip > 4.2 && speedOf(b) > 3) {
      const a = Math.min((b.slip - 4.2) / 8, 1)
      for (const side of [1, -1]) {
        const off = model.profile.width / 2 - 0.25
        const back = model.profile.wr
        const x = b.x + Math.cos(b.yaw) * off * side + Math.sin(b.yaw) * back
        const z = b.z - Math.sin(b.yaw) * off * side + Math.cos(b.yaw) * back
        this.effects.skid(x, z, b.yaw, 0.24, 0.25 + a * 0.45, v.id * 2 + (side > 0 ? 0 : 1))
        const surf = this.game.map.surface(x, z)
        if (Math.random() < a * 0.8) this.effects.tireSmoke(x, z, a, surf === 'grass' || surf === 'lot')
      }
    } else {
      this.effects.skidLift(v.id * 2)
      this.effects.skidLift(v.id * 2 + 1)
    }
  }

  // --- 出来事 ----------------------------------------------------------------------------

  onEvents(events: GameEvent[]): void {
    const me = this.game.player.body
    for (const e of events) {
      switch (e.kind) {
        case 'crash': {
          this.effects.sparks(e.x, 0.7, e.z, Math.min(30, Math.round(e.impact * 1.5)))
          if (e.impact > 8) this.effects.debris(e.x, 0.9, e.z, Math.round(e.impact))
          // 強くぶつかるとガラスが「バリン」と砕けて飛び散る
          if (e.impact > 11) this.effects.glass(e.x, 1.1, e.z, Math.min(160, Math.round(e.impact * 6)))
          if (e.player) this.shake = Math.min(1, this.shake + e.impact / 25)
          break
        }
        case 'pedHit':
          if (e.player) this.shake = Math.min(1, this.shake + 0.15)
          break
        case 'shopSmash': {
          // ショーウィンドウが砕けて、ガラス片・商品・ほこりが道へ飛び出す
          const d = Math.hypot(e.x - me.x, e.z - me.z)
          this.effects.glass(e.x + e.nx * 0.3, 1.6, e.z + e.nz * 0.3, 220, e.nx * 6, e.nz * 6)
          this.effects.debris(e.x, 1.2, e.z, 40)
          for (let k = 0; k < 10; k++) this.effects.tireSmoke(e.x + e.nx * Math.random() * 3, e.z + e.nz * Math.random() * 3, 1, true)
          if (e.player) this.shake = Math.min(1.5, this.shake + 0.5 + e.speed / 40)
          else this.shake = Math.min(1, this.shake + Math.max(0, 0.4 - d / 100))
          break
        }
        case 'splash':
          this.effects.splash(e.x, e.z)
          if (e.player) this.shake = Math.min(1.5, this.shake + 0.8)
          break
        case 'shot':
          this.effects.shot(e.fx, e.fy, e.fz, e.tx, e.tz, e.hit)
          if (e.hit) this.shake = Math.min(1, this.shake + 0.12)
          break
        case 'propBreak':
          this.effects.sparks(e.x, 1, e.z, 12)
          break
        case 'explosion': {
          this.effects.explosion(e.x, e.z)
          const d = Math.hypot(e.x - me.x, e.z - me.z)
          this.shake = Math.min(1.5, this.shake + Math.max(0, 1.4 - d / 40))
          for (const view of this.cars.values()) {
            if (Math.hypot(view.vehicle.body.x - e.x, view.vehicle.body.z - e.z) < 3) view.bounce = 0.8
          }
          break
        }
      }
    }
  }

  // --- マーカー --------------------------------------------------------------------------

  private markerMesh(i: number): THREE.Mesh {
    while (this.markerMeshes.length <= i) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      })
      const ring = new THREE.Mesh(this.ringGeo, mat)
      const beam = new THREE.Mesh(this.beamGeo, mat)
      ring.add(beam)
      this.markers.add(ring)
      this.markerMeshes.push(ring)
    }
    return this.markerMeshes[i]
  }

  private updateMarkers(): void {
    const g = this.game
    let k = 0
    const place = (x: number, z: number, color: number, pulse = 1) => {
      const m = this.markerMesh(k++)
      m.visible = true
      m.position.set(x, 0, z)
      const mat = m.material as THREE.MeshBasicMaterial
      mat.color.setHex(color)
      mat.opacity = (0.28 + Math.sin(this.time * 3) * 0.08) * pulse
    }
    const mission = g.mission
    if (!mission) {
      for (const mk of g.markers) {
        place(mk.x, mk.z, mk.story ? 0xffc53a : mk.def.kind === 'rampage' ? 0xff4a4a
          : mk.def.kind === 'escape' ? 0x6a8cff : mk.def.kind === 'takedown' ? 0xff7a2a : 0x3ad0ff)
      }
    } else if (mission.target && mission.def.kind !== 'takedown') {
      place(mission.target[0], mission.target[1], 0x4aff7a, 1.4)
    }
    for (let i = k; i < this.markerMeshes.length; i++) this.markerMeshes[i].visible = false

    // 標的の車の上に赤い矢印
    const tv = g.vehicles.find((v) => v.id === g.targetVehicle)
    this.arrow.visible = !!tv && !tv.wrecked
    if (tv) {
      this.arrow.position.set(tv.body.x, 4 + Math.sin(this.time * 4) * 0.3, tv.body.z)
      this.arrow.rotation.y = this.time * 2
    }
  }

  // --- カメラ ----------------------------------------------------------------------------

  private updateCamera(dt: number): void {
    // デバッグ用: コンソールから window.__cityCam = { p: [x, y, z], t: [x, y, z] } でカメラを固定できる
    const dbg = (window as unknown as { __cityCam?: { p: number[]; t: number[] } }).__cityCam
    if (dbg) {
      this.camera.position.set(dbg.p[0], dbg.p[1], dbg.p[2])
      this.camera.lookAt(dbg.t[0], dbg.t[1], dbg.t[2])
      return
    }
    const b = this.game.player.body
    const c = CAM[this.cameraMode]
    const speed = speedOf(b)
    // 進んでいる向きへ少しずつ回り込む（ドリフト中に横を向きすぎないように、速度の向きも混ぜる）
    let yaw = b.yaw + this.orbit + (this.lookBack ? Math.PI : 0)
    if (speed > 4 && this.cameraMode !== 2 && !this.lookBack) {
      const vel = Math.atan2(b.vx, b.vz)
      let d = vel - b.yaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      if (Math.abs(d) < 1.3) yaw += d * 0.35
    }
    const fx = Math.sin(yaw), fz = Math.cos(yaw)
    const back = c.back + speed * (this.cameraMode === 2 ? 0 : 0.045)
    const want = new THREE.Vector3(b.x - fx * back, b.y + c.up + speed * 0.012, b.z - fz * back)
    const aim = new THREE.Vector3(b.x + fx * c.look, b.y + (this.cameraMode === 2 ? 1.1 : 1.2), b.z + fz * c.look)

    // 建物にめり込むなら車の側へ寄せる
    if (this.cameraMode !== 2) {
      const map = this.game.map
      for (let t = 0.15; t <= 1.0001; t += 0.1) {
        const x = b.x + (want.x - b.x) * t, z = b.z + (want.z - b.z) * t
        if (map.insideBuilding(x, z, 0.4)) {
          const tt = Math.max(0.12, t - 0.12)
          want.x = b.x + (want.x - b.x) * tt
          want.z = b.z + (want.z - b.z) * tt
          want.y += (1 - tt) * 2
          break
        }
      }
    }
    if (!this.camInit) { this.camPos.copy(want); this.camAim.copy(aim); this.camInit = true }
    const k = this.cameraMode === 2 ? 1 : 1 - Math.exp(-dt * 7)
    this.camPos.lerp(want, k)
    this.camAim.lerp(aim, this.cameraMode === 2 ? 1 : 1 - Math.exp(-dt * 12))
    this.camera.position.copy(this.camPos)
    // 揺れ（衝突・爆発・高速）
    this.shake = Math.max(0, this.shake - dt * 2.2)
    const sh = this.shake * 0.35 + Math.max(0, speed - 30) * 0.0025
    this.camera.position.x += (Math.random() - 0.5) * sh
    this.camera.position.y += (Math.random() - 0.5) * sh
    this.camera.lookAt(this.camAim)
    const fov = 58 + Math.min(speed, 60) * 0.28
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3)
      this.camera.updateProjectionMatrix()
    }
  }

  // --- 毎フレーム --------------------------------------------------------------------------

  update(dt: number): void {
    this.time += dt
    const g = this.game
    this.updateSky(g.clock)
    this.syncCars(dt)
    const groundY = (x: number, z: number) => (g.map.surface(x, z) === 'road' ? 0 : CURB_HEIGHT)
    const pb = g.player.body
    const near = this.skinned.update(dt, g.peds.list, pb.x, pb.z, g.stars > 0, groundY)
    this.peds.update(g.peds.list, this.time, groundY, near)
    this.city.update(g.time, g.broken, g.brokenYaw)
    this.updateMarkers()
    this.updateCamera(dt)
    this.effects.update(dt, this.camera)

    // 影は自分のまわりだけ（影の地図の升目に合わせて動かし、ちらつきを防ぐ）
    const b = g.player.body
    const snap = 190 / this.sun.shadow.mapSize.x
    const cx = Math.round(b.x / snap) * snap, cz = Math.round(b.z / snap) * snap
    this.sun.position.set(cx + this.sunLight.x * 300, this.sunLight.y * 300, cz + this.sunLight.z * 300)
    this.sun.target.position.set(cx, 0, cz)

    // 自分の車のヘッドライト（本物の光）
    const n = this.night
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw)
    this.headlight.intensity = n * 220 + (this.theme.weather !== 'clear' ? 40 : 0)
    this.headlight.position.set(b.x + fx * 2.2, 0.9, b.z + fz * 2.2)
    this.headlight.target.position.set(b.x + fx * 22, 0, b.z + fz * 22)

    // 近いパトカーの赤・青の光
    const cops = g.vehicles.filter((v) => v.siren)
      .sort((a, c) => Math.hypot(a.body.x - b.x, a.body.z - b.z) - Math.hypot(c.body.x - b.x, c.body.z - b.z))
    const cop = cops[0]
    for (let i = 0; i < 2; i++) {
      const L = this.copLights[i]
      if (!cop) { L.intensity = 0; continue }
      const on = Math.floor(this.time * 7 + cop.id) % 2 === i
      L.intensity = on ? 60 + n * 80 : 0
      L.position.set(cop.body.x + (i ? -0.4 : 0.4), 2.2, cop.body.z)
    }

    this.updateSmashed()
    this.plants.update(dt, g.player.body.x, g.player.body.z)
    this.landmarks.update(dt, this.time, this.night)

    // 景色（観覧車・灯台・船・雲）
    this.scenery.update(dt, this.time, n, this.sun.color)
    this.updateHeli(dt, n)

    // 波
    const wn = (this.city.water.material as THREE.MeshStandardMaterial).normalMap
    if (wn) wn.offset.set(this.time * 0.004, this.time * 0.0025)

    if (this.composer) this.composer.render(dt)
    else this.renderer.render(this.scene, this.camera)
  }

  /** 新しく壊した店に、壊れた跡（割れたガラスの向こうの荒れた店内・道に散らばった商品）を置く */
  private updateSmashed(): void {
    const list = this.game.smashed
    while (this.smashedShown < list.length) {
      const sm = list[this.smashedShown++]
      const plane = new THREE.Mesh(this.smashGeo, this.smashMat)
      plane.position.set(sm.x + sm.nx * 0.03, CURB_HEIGHT + 1.75, sm.z + sm.nz * 0.03)
      plane.rotation.y = Math.atan2(sm.nx, sm.nz)
      this.smashGroup.add(plane)
      const goods = new THREE.InstancedMesh(this.goodsGeo, this.goodsMat, 26)
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color()
      for (let k = 0; k < 26; k++) {
        const out = Math.random() * 4.5, side = (Math.random() - 0.5) * 5
        const x = sm.x + sm.nx * out + sm.nz * side, z = sm.z + sm.nz * out - sm.nx * side
        q.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3))
        const sc = 0.5 + Math.random() * 1.2
        m.compose(new THREE.Vector3(x, CURB_HEIGHT + 0.12 * sc, z), q, new THREE.Vector3(sc, sc, sc))
        goods.setMatrixAt(k, m)
        goods.setColorAt(k, c.setHex([0xc83030, 0xe0c040, 0x3070c0, 0x40a050, 0xe8e8e8, 0x8a5a30][k % 6]))
      }
      goods.castShadow = true
      this.smashGroup.add(goods)
    }
  }

  /** 警察のヘリ: 位置・傾き・ローター・サーチライト */
  private updateHeli(dt: number, n: number): void {
    const h = this.game.heli
    if (!h) {
      if (this.heli) { this.scene.remove(this.heli.group); this.heli.dispose(); this.heli = null }
      return
    }
    if (!this.heli) { this.heli = buildHeli(); this.scene.add(this.heli.group) }
    const m = this.heli
    m.group.position.set(h.x, h.y, h.z)
    m.group.rotation.y = h.yaw
    m.body.rotation.set(h.pitch, 0, -h.roll)
    m.rotor.rotation.y = h.rotor
    m.tail.rotation.x = h.rotor * 1.7
    // サーチライトは自分の車を照らし続ける
    const b = this.game.player.body
    m.light.target.position.set(b.x, 0, b.z)
    m.light.intensity = h.leaving ? 0 : 2000 * (0.3 + n)
    const dx = b.x - h.x, dz = b.z - h.z, dy = -h.y
    const len = Math.hypot(dx, dy, dz)
    m.beam.scale.set(1, len / 40, 1)
    m.beam.position.set(0, 0.4, 0)
    // 光の筋の円錐を、ヘリから車へ向ける（円錐は −y 向きに作ってある）
    const dir = new THREE.Vector3(dx, dy, dz).normalize()
    const inv = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, h.yaw, 0)).invert()
    dir.applyQuaternion(inv)
    m.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir)
    ;(m.beam.material as THREE.MeshBasicMaterial).opacity = h.leaving ? 0 : 0.05 + n * 0.12
    void dt
  }

  dispose(): void {
    for (const d of this.disposers) d()
    this.plants.dispose()
    this.landmarks.dispose()
    this.skinned.dispose()
    this.heli?.dispose()
    this.smashTex.dispose(); this.smashMat.dispose(); this.smashGeo.dispose(); this.goodsGeo.dispose(); this.goodsMat.dispose()
    this.scenery.dispose()
    for (const view of this.cars.values()) view.model.dispose()
    this.city.dispose()
    this.peds.dispose()
    this.effects.dispose()
    this.envRT?.dispose()
    this.pmrem.dispose()
    this.glowTex.dispose()
    this.beamGeo.dispose()
    this.ringGeo.dispose()
    this.composer?.dispose()
    this.renderer.dispose()
  }
}
