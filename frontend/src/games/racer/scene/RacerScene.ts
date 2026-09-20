// three.js の場面（シーン）の組み立てと、毎フレームの更新。React には依存しない。
//
// 役割分担:
//   engine/    どこに車がいるか（Python 版と同じ計算）
//   scene/     それをどう見せるか  ← ここ
//   RaceCanvas.tsx  canvas を置いて、この場面を毎フレーム回す
//
// カメラは車の後ろから追いかける。速度が出るほど画角を広げ、遠くを見るようにしてあるので、
// 速くなるほど景色が横に流れて速く感じる。

import * as THREE from 'three'
import * as CO from '../engine/course'
import * as P from '../engine/physics'
import { buildCar, type CarModel } from './buildCar'
import { buildTrack, type TrackModel } from './buildTrack'
import { buildWorld, type WorldModel } from './buildWorld'
import { Flame, Particles } from './effects'
import { designFor } from './carDesigns'
import type { Theme } from './themes'

const CAM_BACK = 9.4 // 車の後ろ何 m から見るか
const CAM_UP = 3.5
const CAM_LOOK = 16 // 車の何 m 先を見るか
const CAM_SMOOTH = 7.5 // カメラの追従の速さ（大きいほどきびきび動く）
const FOV_BASE = 62
const FOV_GAIN = 18 // 最高速のときに画角をどれだけ広げるか

export interface CarEntry {
  model: CarModel
  flame: Flame
  car: P.Car
  /** 見た目の寸法表（毎フレーム引き直さないように持っておく） */
  design: ReturnType<typeof designFor>
  /** 前のフレームの状態（煙を出すか・着地したかの判断に使う） */
  wasGround: boolean
  wheelSpin: number
}

export class RacerScene {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private track: TrackModel
  private world: WorldModel
  private particles = new Particles()
  private cars: CarEntry[] = []
  private course: CO.Course
  private theme: Theme
  private time = 0
  private camPos = new THREE.Vector3()
  private camAim = new THREE.Vector3()
  private started = false
  private tmp = new THREE.Vector3()

  constructor(canvas: HTMLCanvasElement, course: CO.Course, theme: Theme) {
    this.course = course
    this.theme = theme
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar)
    this.camera = new THREE.PerspectiveCamera(FOV_BASE, 16 / 9, 0.4, 3400)

    this.track = buildTrack(course, theme)
    this.world = buildWorld(course, theme)
    this.scene.add(this.track.group, this.world.group, this.particles.points)
    this.resize()
  }

  /** 車を 1 台足す。戻り値の番号を update() の状態の並びと合わせる */
  addCar(carId: string, color?: number, ghost = false): number {
    const model = buildCar(carId, color)
    if (ghost) {
      model.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = o.material as THREE.Material
          m.transparent = true
          m.opacity = 0.45
          o.castShadow = false
        }
      })
      model.shadow.visible = false
    }
    const design = designFor(carId)
    const exhausts = design.parts
      .filter((p) => p.shape === 'cylinder')
      .flatMap((p) => (p.mirror ? [[p.at[0], p.at[1], p.at[2] - 0.35], [-p.at[0], p.at[1], p.at[2] - 0.35]]
                                : [[p.at[0], p.at[1], p.at[2] - 0.35]])) as [number, number, number][]
    const flame = new Flame(exhausts.length ? exhausts : [[0, 0.4, -2]], ghost ? 0xaaccff : 0x8fd8ff)
    model.body.add(flame.group)
    this.scene.add(model.group)
    this.cars.push({ model, flame, car: P.loadCar(carId), design, wasGround: true, wheelSpin: 0 })
    return this.cars.length - 1
  }

  /** 車の見た目を、物理の状態に合わせて動かす */
  private placeCar(e: CarEntry, s: P.State, steer: number, dt: number): void {
    const c = this.course
    const idx = Math.trunc(s.seg)
    const g = e.model.group
    g.position.set(s.x, s.y, s.z)

    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
    const rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw)
    const vlong = s.vx * fx + s.vz * fz
    const vlat = s.vx * rx + s.vz * rz
    const grounded = s.on_ground > 0.5

    // 前後の傾き: 接地中は道の坂に合わせ、空中では上下の速さで機首を上げ下げする
    const nxt = CO.mod(idx + 1, c.n)
    const slope = (c.y[nxt] - c.y[idx]) / c.spacing
    const pitch = grounded ? -Math.atan(slope) : -Math.atan(s.vy / Math.max(Math.abs(vlong), 8)) * 0.7
    // 左右の傾き: 道のバンクに合わせ、横滑りのぶんだけ車体を振る
    // 車体のローカル +x は運転者から見た左なので、道のバンクと同じ符号で傾けると道に沿う
    const roll = (grounded ? c.bank[idx] : 0) + THREE.MathUtils.clamp(vlat * 0.014, -0.28, 0.28)

    g.rotation.order = 'YXZ'
    g.rotation.set(
      THREE.MathUtils.damp(g.rotation.x, pitch, 9, dt),
      s.yaw,
      THREE.MathUtils.damp(g.rotation.z, roll, 9, dt),
    )

    // タイヤ: 進んだぶんだけ回し、前輪はステアに合わせて向きを変える
    const design = e.design
    const radius = design.wheel.radius
    e.wheelSpin += (vlong / radius) * dt
    for (const w of e.model.wheels) w.rotation.x = e.wheelSpin
    for (const p of e.model.frontWheels) p.rotation.y = -steer * 0.5

    // 丸い影は必ず地面に置く（車が飛んでいるあいだは薄く・小さくする）
    const ground = c.y[idx]
    e.model.shadow.position.set(0, ground - s.y + 0.03, 0)
    const airK = THREE.MathUtils.clamp(1 - (s.y - ground) / 14, 0.15, 1)
    e.model.shadow.scale.set(design.shadow[0] * airK, design.shadow[1] * airK, 1)
    ;(e.model.shadow.material as THREE.MeshBasicMaterial).opacity = 0.32 * airK

    // サスペンションの上下（見た目だけ）
    e.model.body.position.y = THREE.MathUtils.damp(e.model.body.position.y, grounded ? 0 : 0.08, 8, dt)

    // ブーストの炎
    e.flame.update(s.boost > 0 ? THREE.MathUtils.clamp(s.boost / P.BOOST_TIME, 0.35, 1) : 0, this.time)

    // 煙とほこり
    const dust = new THREE.Color(this.theme.ground).lerp(new THREE.Color(0xffffff), 0.35)
    if (grounded && Math.abs(vlat) > 6) {
      const back = design.wheel.back
      for (const side of [1, -1]) {
        const px = s.x + fx * back + rx * design.wheel.side * side
        const pz = s.z + fz * back + rz * design.wheel.side * side
        this.particles.emit(px, s.y + 0.25, pz, dust, 1.3,
                            0.5 + Math.random() * 0.4,
                            (Math.random() - 0.5) * 3, 1.5 + Math.random(), (Math.random() - 0.5) * 3)
      }
    }
    if (grounded && !e.wasGround) {
      for (let i = 0; i < 10; i++) {
        this.particles.emit(s.x, s.y + 0.2, s.z, dust, 1.8, 0.6,
                            (Math.random() - 0.5) * 9, 2 + Math.random() * 3, (Math.random() - 0.5) * 9)
      }
    }
    e.wasGround = grounded
  }

  /**
   * 1 フレーム進める。
   * states は addCar() で足した順、follow は後ろから追いかける車の番号。
   */
  update(dt: number, states: { state: P.State; steer: number }[], follow = 0): void {
    this.time += dt
    states.forEach((st, i) => {
      if (this.cars[i]) this.placeCar(this.cars[i], st.state, st.steer, dt)
    })
    this.particles.update(dt)

    const me = states[follow]
    if (me) {
      const s = me.state
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
      const speed = Math.hypot(s.vx, s.vz)
      const wantPos = this.tmp.set(s.x - fx * CAM_BACK, s.y + CAM_UP, s.z - fz * CAM_BACK)
      const wantAim = new THREE.Vector3(s.x + fx * CAM_LOOK, s.y + 1.4, s.z + fz * CAM_LOOK)
      if (!this.started) {
        this.camPos.copy(wantPos)
        this.camAim.copy(wantAim)
        this.started = true
      } else {
        // damp: 目標にじわっと近づける。dt が変わっても動きが変わらない
        this.camPos.x = THREE.MathUtils.damp(this.camPos.x, wantPos.x, CAM_SMOOTH, dt)
        this.camPos.y = THREE.MathUtils.damp(this.camPos.y, wantPos.y, CAM_SMOOTH, dt)
        this.camPos.z = THREE.MathUtils.damp(this.camPos.z, wantPos.z, CAM_SMOOTH, dt)
        this.camAim.lerp(wantAim, Math.min(1, dt * CAM_SMOOTH * 1.4))
      }
      this.camera.position.copy(this.camPos)
      this.camera.lookAt(this.camAim)
      const boost = s.boost > 0 ? 6 : 0
      const want = FOV_BASE + (speed / this.cars[follow].car.vmax) * FOV_GAIN + boost
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, want, 4, dt)
      this.camera.updateProjectionMatrix()

      // 影の範囲を車について回らせる（コース全体を影にすると粗くなるため）
      this.world.sun.position.set(...this.theme.sunDir).multiplyScalar(260).add(
        new THREE.Vector3(s.x, s.y, s.z))
      this.world.sun.target.position.set(s.x, s.y, s.z)
      this.world.sun.target.updateMatrixWorld()
    }
    this.renderer.render(this.scene, this.camera)
  }

  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth || 960
    const h = canvas.clientHeight || 540
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    for (const c of this.cars) { c.model.dispose(); c.flame.dispose() }
    this.particles.dispose()
    this.track.dispose()
    this.world.dispose()
    this.renderer.dispose()
  }
}
