// three.js（WebGL）で描く夜の森。React には依存しない。
//
// 役割分担:
//   sim/        影がどこにいて、何を打てばいいか（ルール）
//   scene/      それをどう見せるか  ← ここ
//   ForestCanvas.tsx  canvas を置いて、この場面を毎フレーム回す。言葉の札（HTML）もそこで重ねる
//
// 向き: プレイヤー（カメラ）は原点に立ち、+z（森の奥）を向いている。影は奥から近づいてくる。
// 歩いている感じは「木やホタルを手前へ流し、後ろへ消えたら奥へ戻す」ことで出している
// （地面は模様が無いので動かさなくてよい）。
//
// 光らせ方: 描いた絵にブルーム（明るいところをにじませる後処理）を掛けている。
// 影の目・ホタル・ランタン・月・光の筋は明るさが 1 を超える色にしてあり、それがにじんで光って見える。
// スマホなど小さい画面では重いのでブルームを切る（quality = 'low'）。
//
// update() に game を渡さない（null）と「タイトル画面の森」になる。ゆっくり歩き、遠くに影が何体か漂う。

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { Behavior } from '../sim/chapters'
import { type Enemy, type EnemyKind, type GameEvent, MAX_OIL, type TypingGame } from '../sim/game'
import { Mist } from './mist'
import { AmbientFireflies, Particles } from './particles'
import { createShadeMaterial, SHAPE_SCALE, type ShadeMaterial, type ShapeName } from './shade'
import { disposeTextures, foxFireTexture, glowTexture, moonTexture } from './textures'
import { type Theme, themeFor } from './themes'

const EYE_HEIGHT = 1.6
/** 木を並べる奥行き（m）。これより奥へ行ったら手前に戻す */
const TREE_RANGE = 130
const FIREFLY = 0xc8ff6a
/** 光の筋（打つたびにランタンから狙った影へ飛ぶ）の数。使い回す */
const BEAMS = 10
const BEAM_LIFE = 0.16

export type Quality = 'high' | 'low'

/** 描くのに要る、影 1 体ぶんの値（ゲームの影でも、タイトル画面の飾りの影でもよい） */
interface Shown {
  id: number
  kind: EnemyKind
  x: number
  z: number
  behavior?: Behavior
  state?: Enemy['state']
}

/**
 * 動き方ごとの見た目（どの影が何をしてくるか、形で見分けられるように）。
 * walk（まっすぐ来る影）だけは章ごとの候補（themes.ts の shades）から選ぶ。
 */
const BEHAVIOR_SHAPES: Partial<Record<Behavior, ShapeName[]>> = {
  creep: ['tall'],
  hop: ['umbrella'],
  lunge: ['oni'],
  blink: ['oneEye'],
  zigzag: ['cat'],
  ambush: ['serpent'],
  tank: ['wall'],
  split: ['twins'],
  mini: ['cat', 'kodama'],
  shooter: ['tengu'],
  ink: ['jelly'],
  howl: ['longNeck'],
  leech: ['foxMask'],
  caller: ['lantern'],
  mimic: ['kodama'],
  golden: ['round'],
}
const GOLD = 0xffc040

interface EnemyModel {
  group: THREE.Group
  body: THREE.Mesh | THREE.Sprite
  /** 影とボスのシェーダー（狐火は null） */
  mat: ShadeMaterial | null
  kind: EnemyKind
  size: number
  /** 打たれた・傷ついたときに一瞬ふくらむ */
  pulse: number
  /** 傷ついたときに一瞬白く光る */
  flash: number
  bob: number
  /** 狙われ具合（0〜1。なめらかに変える） */
  lock: number
}

interface Beam {
  mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  life: number
}

interface Scenery {
  x: number
  z: number
  s: number
  r: number
}

/** 小さい画面・タッチの端末ではブルームを切る（重いため） */
export function defaultQuality(): Quality {
  if (typeof window === 'undefined') return 'low'
  const small = Math.min(window.innerWidth, window.innerHeight) < 600
  const touch = window.matchMedia?.('(pointer: coarse)').matches
  return small || touch ? 'low' : 'high'
}

export class ForestScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400)
  private theme: Theme
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  private hemi: THREE.HemisphereLight
  private lanternLight: THREE.PointLight
  private lanternGlow: THREE.Sprite
  private lanternCore: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>
  private trees: Scenery[] = []
  private trunks: THREE.InstancedMesh
  private crowns: THREE.InstancedMesh
  private mushrooms: { items: Scenery[]; mesh: THREE.InstancedMesh } | null = null
  /** 足もとの草と石（歩くと後ろへ流れ、進んでいる感じを出す） */
  private grass: { items: Scenery[]; mesh: THREE.InstancedMesh }
  private stones: { items: Scenery[]; mesh: THREE.InstancedMesh }
  /** 足音を鳴らすための歩みの位相（stepTaken() で 1 歩ごとに true を返す） */
  private stride = 0
  private stepPending = false
  private torii: THREE.Group[] = []
  private stoneLanterns: THREE.Group[] = []
  private fireflies: AmbientFireflies
  private particles = new Particles(1600)
  private mist: Mist
  private models = new Map<number, EnemyModel>()
  private shadeGeo = new THREE.PlaneGeometry(1, 1)
  private beams: Beam[] = []
  private nextBeam = 0
  private composer: EffectComposer | null = null
  /** 鈴を鳴らしたときに地面を広がる光の輪 */
  private bellRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private bellTime = -1
  /** タイトル画面で遠くを漂う飾りの影 */
  private decor: (Shown & { phase: number; baseX: number; baseZ: number })[] = []
  /** 形を決め打ちする影（確認用の一覧 showGallery で使う） */
  private forcedShape = new Map<number, ShapeName>()
  private gallery = false
  private time = 0
  private shake = 0
  private walkSpeed = 0
  private dawn = 0
  private dummy = new THREE.Object3D()
  private tmpV = new THREE.Vector3()
  private tmpC = new THREE.Color()

  constructor(canvas: HTMLCanvasElement, themeId: string, quality: Quality = defaultQuality()) {
    this.theme = themeFor(themeId)
    const t = this.theme
    // ブルームを使うときは描き先の MSAA でギザギザを消すので、ここでのアンチエイリアスは要らない
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.scene.fog = new THREE.FogExp2(t.fog, t.fogDensity)
    this.scene.background = new THREE.Color(t.skyBottom)

    this.camera.position.set(0, EYE_HEIGHT, 0)
    this.camera.lookAt(0, EYE_HEIGHT - 0.1, 10)
    this.scene.add(this.camera)

    // --- 空・星・月 ---
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { top: { value: new THREE.Color(t.skyTop) }, bottom: { value: new THREE.Color(t.skyBottom) } },
        vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.05, 0.55, h)), 1.0); }',
      }),
    )
    this.scene.add(this.sky)
    this.scene.add(this.buildStars())
    if (t.moonSize > 0) {
      const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture(), color: t.moon, fog: false, depthWrite: false }))
      moon.position.set(-40, 75, 220)
      moon.scale.setScalar(t.moonSize * 6)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: t.moon, fog: false, depthWrite: false, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending,
      }))
      halo.position.copy(moon.position)
      halo.scale.setScalar(t.moonSize * 18)
      this.scene.add(halo, moon)
    }

    // --- 光 ---
    this.hemi = new THREE.HemisphereLight(t.ambient, t.ground, 1.1)
    this.scene.add(this.hemi)
    const moonLight = new THREE.DirectionalLight(t.moon, 0.35)
    moonLight.position.set(-40, 75, 220)
    this.scene.add(moonLight)
    // ランタン（右手に持っている）。光は少し前に置くと、近づいた影がよく照らされる
    this.lanternLight = new THREE.PointLight(t.lantern, 14, 28, 1.3)
    this.lanternLight.position.set(0.5, -0.4, -1.2)
    this.camera.add(this.lanternLight)
    const lantern = this.buildLantern()
    this.lanternCore = lantern.core
    this.lanternGlow = lantern.glow
    this.camera.add(lantern.group)
    if (t.noLantern) {
      lantern.group.visible = false
      this.lanternLight.visible = false
    }

    // --- 地面と道 ---
    this.scene.add(this.buildGround())

    // --- 木（幹と葉をそれぞれ 1 つの InstancedMesh にまとめる。数百本でも軽い） ---
    const treeCount = t.props.fewTrees ? 90 : 230
    const minX = t.props.fewTrees ? 10 : 5.5
    for (let i = 0; i < treeCount; i++) {
      const side = Math.random() < 0.5 ? -1 : 1
      this.trees.push({ x: side * (minX + Math.random() ** 1.5 * 34), z: Math.random() * TREE_RANGE - 6, s: 0.7 + Math.random() * 0.9, r: Math.random() * Math.PI })
    }
    this.trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.16, 0.3, 1, 6), new THREE.MeshLambertMaterial({ color: t.trunk }), treeCount)
    this.crowns = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 7), new THREE.MeshLambertMaterial({ color: t.foliage }), treeCount * 2)
    this.scene.add(this.trunks, this.crowns)

    if (t.props.mushrooms) this.mushrooms = this.buildMushrooms()
    // 足もとの草（道の両わき）と、道に転がる小石
    this.grass = this.buildScatter(520, 1.6, 12, new THREE.ConeGeometry(0.05, 0.4, 3), new THREE.MeshLambertMaterial({ color: new THREE.Color(t.foliage).multiplyScalar(1.6) }), 0.6, 1.5)
    this.stones = this.buildScatter(140, 0, 3, new THREE.DodecahedronGeometry(0.09, 0), new THREE.MeshLambertMaterial({ color: 0x5a5a56 }), 0.6, 1.6)
    if (t.props.torii) {
      for (let i = 0; i < 5; i++) {
        const g = this.buildTorii()
        g.position.z = 12 + i * 26
        this.torii.push(g)
        this.scene.add(g)
      }
    }
    if (t.props.stoneLanterns) {
      for (let i = 0; i < 12; i++) {
        const g = this.buildStoneLantern()
        g.position.set(i % 2 ? -5 : 5, 0, 4 + Math.floor(i / 2) * 14)
        this.stoneLanterns.push(g)
        this.scene.add(g)
      }
    }

    // --- 地面の霧・ホタル・光の粒 ---
    this.mist = new Mist(new THREE.Color(t.fog).lerp(new THREE.Color(0x8a9ab8), 0.35), t.mist)
    this.scene.add(this.mist.group)
    this.fireflies = new AmbientFireflies(180, FIREFLY)
    this.scene.add(this.fireflies.points, this.particles.points)

    // --- 光の筋: 細い円柱を使い回す。色は 1 を超える明るさにしてブルームで光らせる ---
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)
    for (let i = 0; i < BEAMS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(t.lantern).multiplyScalar(3), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      })
      const mesh = new THREE.Mesh(beamGeo, mat)
      mesh.visible = false
      this.scene.add(mesh)
      this.beams.push({ mesh, life: 0 })
    }

    // --- 鈴の光の輪（ふだんは隠しておく） ---
    this.bellRing = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 72),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffe2a0).multiplyScalar(2.5), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }),
    )
    this.bellRing.rotation.x = -Math.PI / 2
    this.bellRing.position.y = 0.4
    this.bellRing.visible = false
    this.scene.add(this.bellRing)

    // --- タイトル画面用の飾りの影（ゲーム中は出さない） ---
    const decorCount = t.decor ?? 4
    for (let i = 0; i < decorCount; i++) {
      const baseX = (i - 1.5) * 4.5 + (Math.random() - 0.5) * 2
      const baseZ = 17 + Math.random() * 10
      this.decor.push({ id: -1 - i, kind: 'shade', x: baseX, z: baseZ, baseX, baseZ, phase: Math.random() * 10 })
    }

    if (quality === 'high') {
      // ブルームのために一度別の画像へ描く。描き先を MSAA（4 倍のサンプル）つきにして輪郭のギザギザを消す
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
      this.composer = new EffectComposer(this.renderer, target)
      this.composer.addPass(new RenderPass(this.scene, this.camera))
      // 強さ・広がり・しきい値（これより明るいところだけにじむ）
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.85, 0.55, 0.62))
      this.composer.addPass(new OutputPass())
    }
    this.placeScenery(0)
  }

  // ------------------------------------------------------------------ 組み立て
  private buildStars(): THREE.Points {
    const n = 700
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 0.95 + 0.05, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u)
      pos.set([r * Math.cos(th) * 280, u * 280, r * Math.sin(th) * 280], i * 3)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8, depthWrite: false,
    }))
  }

  private buildGround(): THREE.Group {
    const t = this.theme
    const group = new THREE.Group()
    const geo = new THREE.PlaneGeometry(160, 200, 60, 80)
    geo.rotateX(-Math.PI / 2)
    // 色を少しずつばらつかせ、土のむらにする
    const colors = new Float32Array(geo.attributes.position.count * 3)
    const base = new THREE.Color(t.props.water ?? t.ground)
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const k = 0.75 + Math.random() * 0.5
      colors.set([base.r * k, base.g * k, base.b * k], i * 3)
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = t.props.water
      ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.6 })
      : new THREE.MeshLambertMaterial({ vertexColors: true })
    const ground = new THREE.Mesh(geo, mat)
    ground.position.z = 80
    group.add(ground)
    // 道（水の章では、水の上に土の道が一本通っている）
    const path = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 200), new THREE.MeshLambertMaterial({ color: t.path }))
    path.rotation.x = -Math.PI / 2
    path.position.set(0, 0.01, 80)
    group.add(path)
    return group
  }

  private buildLantern(): { group: THREE.Group; core: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>; glow: THREE.Sprite } {
    const group = new THREE.Group()
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x2a2018 })
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12), new THREE.MeshBasicMaterial({ color: this.theme.lantern, fog: false }))
    group.add(core)
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.2, 0.015), frameMat)
      bar.position.set(x * 0.07, 0, z * 0.07)
      group.add(bar)
    }
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.07, 4), frameMat)
    cap.position.y = 0.13
    cap.rotation.y = Math.PI / 4
    group.add(cap)
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.16), frameMat)
    base.position.y = -0.1
    group.add(base)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: this.theme.lantern, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, opacity: 0.8,
    }))
    glow.scale.setScalar(0.9)
    group.add(glow)
    // 画面の右下に小さく見える位置（カメラから見た座標。-z が前）
    group.position.set(0.62, -0.5, -1.6)
    group.scale.setScalar(0.75)
    return { group, core, glow }
  }

  /** 道のまわりに小物をばらまく（minX〜maxX の範囲。0 なら道の上も含む） */
  private buildScatter(n: number, minX: number, maxX: number, geo: THREE.BufferGeometry, mat: THREE.Material,
                       sMin: number, sMax: number): { items: Scenery[]; mesh: THREE.InstancedMesh } {
    const items: Scenery[] = []
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1
      items.push({ x: side * (minX + Math.random() * (maxX - minX)), z: Math.random() * 60 - 6, s: sMin + Math.random() * (sMax - sMin), r: Math.random() * Math.PI })
    }
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    this.scene.add(mesh)
    return { items, mesh }
  }

  private buildMushrooms(): { items: Scenery[]; mesh: THREE.InstancedMesh } {
    const n = 70
    const items: Scenery[] = []
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1
      items.push({ x: side * (2.4 + Math.random() * 6), z: Math.random() * TREE_RANGE - 6, s: 0.6 + Math.random() * 0.8, r: 0 })
    }
    // 光るキノコ（1 を超える色でブルームが掛かる）
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6affd8).multiplyScalar(1.6) }), n)
    this.scene.add(mesh)
    return { items, mesh }
  }

  private buildTorii(): THREE.Group {
    const g = new THREE.Group()
    const red = new THREE.MeshLambertMaterial({ color: 0x8a1c14 })
    const dark = new THREE.MeshLambertMaterial({ color: 0x1a1210 })
    for (const x of [-2.6, 2.6]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 4.2, 10), red)
      pillar.position.set(x, 2.1, 0)
      g.add(pillar)
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(7, 0.28, 0.4), dark)
    top.position.y = 4.35
    const tie = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 0.25), red)
    tie.position.y = 3.6
    g.add(top, tie)
    return g
  }

  private buildStoneLantern(): THREE.Group {
    const g = new THREE.Group()
    const stone = new THREE.MeshLambertMaterial({ color: 0x5a5a54 })
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.9, 6), stone)
    post.position.y = 0.45
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.32, 0.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(1.5) }))
    box.position.y = 1.06
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.3, 4), stone)
    roof.position.y = 1.36
    roof.rotation.y = Math.PI / 4
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xff9a40, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    glow.position.y = 1.06
    glow.scale.setScalar(1.6)
    g.add(post, box, roof, glow)
    return g
  }

  private buildEnemy(e: Shown): EnemyModel {
    const group = new THREE.Group()
    let body: THREE.Mesh | THREE.Sprite
    let mat: ShadeMaterial | null = null
    let size: number
    if (e.kind === 'orb') {
      // 火の玉: 橙に燃える玉（1 を超える明るさでブルームが掛かる）。毎フレーム火の粉の尾を引く
      size = 0.85
      body = new THREE.Sprite(new THREE.SpriteMaterial({
        map: foxFireTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        color: new THREE.Color(1.7, 0.55, 0.12),
      }))
      body.scale.set(size, size, 1)
    } else if (e.kind === 'fox') {
      size = 1.1
      body = new THREE.Sprite(new THREE.SpriteMaterial({
        map: foxFireTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        color: new THREE.Color(1.4, 1.7, 2.4), // 1 を超える明るさ → ブルームで青白く燃える
      }))
      body.scale.set(size, size * 1.4, 1)
    } else {
      // 形は章ごとの候補から選ぶ（id から決めるので、同じ影の形が途中で変わらない）
      const t = this.theme
      const pick = (list: readonly ShapeName[]) => list[Math.abs(e.id * 7919) % list.length]
      const byBehavior = e.behavior ? BEHAVIOR_SHAPES[e.behavior] : undefined
      const shape: ShapeName = this.forcedShape.get(e.id)
        ?? (e.kind === 'boss' ? t.bossShape : byBehavior ? pick(byBehavior) : pick(t.shades))
      size = (e.kind === 'boss' ? 8.5 : 2.3) * (SHAPE_SCALE[shape] ?? 1)
      const golden = e.behavior === 'golden'
      mat = createShadeMaterial(shape, golden ? GOLD : t.shadeAura, t.fog, t.fogDensity, golden ? 0xfff0a0 : undefined)
      body = new THREE.Mesh(this.shadeGeo, mat)
      body.scale.setScalar(size)
    }
    group.add(body)
    this.scene.add(group)
    return { group, body, mat, kind: e.kind, size, pulse: 0, flash: 0, bob: Math.random() * 10, lock: 0 }
  }

  // ------------------------------------------------------------------ 毎フレーム
  /** 木・キノコ・鳥居を、歩いたぶん手前へ流す */
  private placeScenery(walked: number): void {
    const d = this.dummy
    let ci = 0
    this.trees.forEach((tr, i) => {
      tr.z -= walked
      if (tr.z < -8) tr.z += TREE_RANGE
      const h = 3.2 * tr.s
      d.position.set(tr.x, h / 2, tr.z)
      d.rotation.set(0, tr.r, 0)
      d.scale.set(tr.s, h, tr.s)
      d.updateMatrix()
      this.trunks.setMatrixAt(i, d.matrix)
      // 葉は円すいを 2 段重ねる（杉っぽく）
      for (const [y, w, hh] of [[h + 1.1 * tr.s, 1.9, 3.2], [h + 2.6 * tr.s, 1.3, 2.6]]) {
        d.position.set(tr.x, y, tr.z)
        d.scale.set(w * tr.s, hh * tr.s, w * tr.s)
        d.updateMatrix()
        this.crowns.setMatrixAt(ci++, d.matrix)
      }
    })
    this.trunks.instanceMatrix.needsUpdate = true
    this.crowns.instanceMatrix.needsUpdate = true

    if (this.mushrooms) {
      this.mushrooms.items.forEach((m, i) => {
        m.z -= walked
        if (m.z < -8) m.z += TREE_RANGE
        d.position.set(m.x, 0, m.z)
        d.rotation.set(0, 0, 0)
        d.scale.setScalar(m.s)
        d.updateMatrix()
        this.mushrooms!.mesh.setMatrixAt(i, d.matrix)
      })
      this.mushrooms.mesh.instanceMatrix.needsUpdate = true
    }
    // 草と石は近くにだけ置き、60m で一周させる（遠くは霧で見えない）
    for (const sc of [this.grass, this.stones]) {
      sc.items.forEach((m, i) => {
        m.z -= walked
        if (m.z < -6) m.z += 60
        d.position.set(m.x, sc === this.grass ? 0.15 * m.s : 0.03, m.z)
        d.rotation.set(sc === this.grass ? (m.r - 1.5) * 0.15 : m.r, m.r, 0)
        d.scale.setScalar(m.s)
        d.updateMatrix()
        sc.mesh.setMatrixAt(i, d.matrix)
      })
      sc.mesh.instanceMatrix.needsUpdate = true
    }
    for (const g of [...this.torii, ...this.stoneLanterns]) {
      g.position.z -= walked
      if (g.position.z < -8) g.position.z += this.torii.includes(g) ? 26 * this.torii.length : 14 * (this.stoneLanterns.length / 2)
    }
  }

  update(dt: number, game: TypingGame | null): void {
    this.time += dt
    // 影がいないあいだは奥へ歩き、影がいるときは足を止めぎみにする。タイトル画面ではゆっくり歩き続ける
    const targetWalk = !game ? 0.9 : game.over ? 0 : game.enemies.length === 0 ? 3.4 : 1.2
    this.walkSpeed += (targetWalk - this.walkSpeed) * Math.min(1, dt * 1.5)
    const walked = this.walkSpeed * dt
    this.placeScenery(walked)

    // ランタン: 油が少ないほど暗く、コンボが続くほど明るい。ゆらゆら揺れる
    const oil = game ? game.oil / MAX_OIL : 1
    const comboBoost = game ? Math.min(1, game.combo / 60) : 0.3
    const flick = 0.9 + 0.1 * Math.sin(this.time * 13) * Math.sin(this.time * 7.3)
    const level = (0.35 + 0.65 * oil) * (1 + comboBoost * 0.8) * flick
    this.lanternLight.intensity = 14 * level
    this.lanternLight.distance = 20 + 14 * comboBoost
    this.lanternGlow.scale.setScalar(0.3 + 0.25 * level)
    this.lanternCore.material.color.set(this.theme.lantern).multiplyScalar(0.9 + 1.3 * level)

    // カメラ: 歩くと少し上下し、襲われると揺れる
    this.shake = Math.max(0, this.shake - dt * 2.5)
    // 歩みの位相: 速く歩くほど歩幅の周期も速い。1 歩ごとに足音の合図を出す
    const prevStride = this.stride
    this.stride += dt * (2.2 + this.walkSpeed * 0.9)
    if (Math.floor(this.stride / Math.PI) !== Math.floor(prevStride / Math.PI) && this.walkSpeed > 0.5) this.stepPending = true
    const walkAmt = Math.min(1, this.walkSpeed / 2)
    const bob = -Math.abs(Math.sin(this.stride)) * 0.07 * walkAmt
    const roll = Math.sin(this.stride) * 0.012 * walkAmt
    const sx = (Math.random() - 0.5) * this.shake * 0.5, sy = (Math.random() - 0.5) * this.shake * 0.5
    this.camera.position.set(sx, EYE_HEIGHT + bob + sy, 0)
    // タイトル画面では、あたりを見回すようにゆっくり視線を動かす
    const look = game ? 0 : Math.sin(this.time * 0.13) * 2.2
    this.camera.lookAt(sx * 0.5 + look + Math.sin(this.stride) * 0.12 * walkAmt, EYE_HEIGHT - 0.1 + bob + (game ? 0 : 0.6), 10)
    this.camera.rotateZ(roll)

    // 終章: ボスを削るほど空が明けていく
    const t = this.theme
    if (game && t.dawnTop !== undefined && t.dawnBottom !== undefined) {
      const boss = game.boss
      const goal = game.result === 'clear' ? 1
        : boss?.phrases ? (boss.phraseIndex ?? 0) / boss.phrases.length * 0.8 : 0
      this.dawn += (goal - this.dawn) * Math.min(1, dt * 0.8)
      const u = this.sky.material.uniforms
      ;(u.top.value as THREE.Color).set(t.skyTop).lerp(this.tmpC.set(t.dawnTop), this.dawn)
      ;(u.bottom.value as THREE.Color).set(t.skyBottom).lerp(this.tmpC.set(t.dawnBottom), this.dawn)
      ;(this.scene.fog as THREE.FogExp2).color.set(t.fog).lerp(this.tmpC.set(t.dawnBottom).multiplyScalar(0.5), this.dawn)
      this.hemi.intensity = 1.1 + this.dawn * 1.5
    }

    if (game) {
      this.syncEnemies(dt, game.enemies, game.target?.id ?? null, game.bossCharging ? game.boss?.id ?? null : null)
      // 闇: 霧が濃くなり、ランタンが暗くなる
      const fog = this.scene.fog as THREE.FogExp2
      const goalDensity = this.theme.fogDensity + (game.darkness > 0 ? 0.09 : 0)
      fog.density += (goalDensity - fog.density) * Math.min(1, dt * 3)
      if (game.darkness > 0) this.lanternLight.intensity *= 0.35
    } else {
      // 飾りの影: 遠くで左右に漂い、ときどき少し近づいてはまた離れる（一覧のときは止めておく）
      for (const d of this.gallery ? [] : this.decor) {
        d.phase += dt
        d.x = d.baseX + Math.sin(d.phase * 0.4) * 1.5
        d.z = d.baseZ + Math.sin(d.phase * 0.23) * 3
      }
      this.syncEnemies(dt, this.decor, null)
    }
    this.mist.update(dt, walked)
    this.updateBeams(dt)
    this.updateBell(dt)
    this.fireflies.update(dt, walked, game?.result === 'clear' ? 1 : 0.6 + 0.4 * comboBoost)
    this.particles.update(dt)
    if (this.composer) this.composer.render(dt)
    else this.renderer.render(this.scene, this.camera)
  }

  private syncEnemies(dt: number, list: readonly Shown[], targetId: number | null, chargingId: number | null = null): void {
    const alive = new Set<number>()
    for (const e of list) {
      alive.add(e.id)
      let m = this.models.get(e.id)
      if (!m) {
        m = this.buildEnemy(e)
        this.models.set(e.id, m)
        if (e.behavior === 'ambush') {
          this.particles.burst(this.tmpV.set(e.x, 0.8, e.z), { count: 50, color: 0x3a8a3a, speed: 3.5, life: 1.2, size: 0.3, lift: -1 })
        }
      }
      m.bob += dt
      m.pulse = Math.max(0, m.pulse - dt * 4)
      m.flash = Math.max(0, m.flash - dt * 5)
      m.lock += ((e.id === targetId ? 1 : 0) - m.lock) * Math.min(1, dt * 10)
      const y = e.kind === 'boss' ? 3.6 : e.kind === 'fox' ? 1.3 : e.kind === 'orb' ? 1.5 : 1.35
      m.group.position.set(e.x, y + Math.sin(m.bob * 2) * (e.kind === 'fox' ? 0.25 : 0.12), e.z)
      const s = m.size * (1 + m.pulse * 0.15)
      if (m.kind === 'orb') {
        m.body.scale.setScalar(s * (1 + Math.sin(m.bob * 25) * 0.12))
        if (Math.random() < 0.6) this.particles.burst(m.group.position, { count: 1, color: 0xff8a30, speed: 0.6, life: 0.45, size: 0.22, lift: 0.3 })
      } else if (m.kind === 'fox') {
        m.body.scale.set(s, s * 1.4 * (1 + Math.sin(m.bob * 15) * 0.06), 1)
      } else {
        // 板をいつもカメラへ向ける（ビルボード）
        m.body.quaternion.copy(this.camera.quaternion)
        m.body.scale.setScalar(s)
      }
      if (m.mat) {
        const u = m.mat.uniforms
        u.uTime.value = this.time
        // 力を溜めている影は、狙われていなくても目が赤く脈打つ（これから飛びかかってくる合図）
        // 吸い付いている影・力を溜めているボスも、赤く脈打つ
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 18)
        const windup = e.state === 'windup' || e.state === 'latched' || e.id === chargingId ? pulse : 0
        if (e.id === chargingId) m.flash = Math.max(m.flash, 0.25 + 0.25 * Math.sin(this.time * 12))
        u.uLock.value = Math.max(m.lock, windup)
        u.uFlash.value = Math.max(m.flash, e.state === 'windup' ? 0.12 : 0)
        u.uFogColor.value.copy((this.scene.fog as THREE.FogExp2).color)
      }
    }
    for (const [id, m] of this.models) {
      if (!alive.has(id)) {
        this.scene.remove(m.group)
        ;(m.body.material as THREE.Material).dispose()
        this.models.delete(id)
      }
    }
  }

  private updateBeams(dt: number): void {
    for (const b of this.beams) {
      if (b.life <= 0) continue
      b.life -= dt
      const k = Math.max(0, b.life / BEAM_LIFE)
      b.mesh.material.opacity = k
      b.mesh.scale.x = b.mesh.scale.z = 0.012 + 0.03 * k
      if (b.life <= 0) b.mesh.visible = false
    }
  }

  private updateBell(dt: number): void {
    if (this.bellTime < 0) return
    this.bellTime += dt
    const k = this.bellTime / 1.2
    if (k >= 1) {
      this.bellTime = -1
      this.bellRing.visible = false
      return
    }
    // 足もとから森の奥へ、光の輪が広がっていく
    this.bellRing.scale.setScalar(1 + k * 34)
    this.bellRing.material.opacity = (1 - k) ** 1.5
  }

  /** ランタンから to へ光の筋を飛ばす */
  private shootBeam(to: THREE.Vector3): void {
    const from = this.lanternGlow.getWorldPosition(new THREE.Vector3())
    const b = this.beams[this.nextBeam]
    this.nextBeam = (this.nextBeam + 1) % this.beams.length
    const dir = to.clone().sub(from)
    const len = dir.length()
    b.mesh.position.copy(from).addScaledVector(dir, 0.5)
    b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    b.mesh.scale.set(0.04, len, 0.04)
    b.mesh.visible = true
    b.life = BEAM_LIFE
  }

  /** 出来事に合わせた演出（光の筋・光の粒・画面の揺れ） */
  handleEvents(events: GameEvent[]): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'key': {
          const m = this.models.get(ev.id)
          if (m) {
            m.pulse = 1
            m.flash = 0.25
            this.shootBeam(m.group.position)
            this.particles.burst(m.group.position, { count: 4, color: 0xffd27a, speed: 1.6, life: 0.5, size: 0.22, lift: 0 })
          }
          break
        }
        case 'kill': {
          const boss = ev.enemy === 'boss'
          const at = this.tmpV.set(ev.x, boss ? 3.6 : 1.35, ev.z)
          if (ev.golden) this.particles.burst(at, { count: 120, color: GOLD, speed: 4, life: 3, size: 0.45, lift: 1 })
          this.particles.burst(at, { count: boss ? 450 : 56, color: FIREFLY, speed: boss ? 7 : 2.8, life: boss ? 5 : 2.8, size: boss ? 0.5 : 0.35, lift: 0.8 })
          this.particles.burst(at, { count: boss ? 90 : 14, color: 0xffffff, speed: boss ? 9 : 3.8, life: 0.6, size: 0.3, lift: 0 })
          break
        }
        case 'boss-hurt': {
          const m = this.models.get(ev.id)
          if (m) {
            m.pulse = 2
            m.flash = 1
            this.shake = 0.5
            this.particles.burst(m.group.position, { count: 100, color: FIREFLY, speed: 5, life: 3, size: 0.4, lift: 0.8 })
          }
          break
        }
        case 'hit':
          this.shake = ev.damage > 1 ? 1.4 : 0.9
          break
        case 'shoot': {
          const m = this.models.get(ev.id)
          if (m) {
            m.pulse = 1.5
            this.particles.burst(m.group.position, { count: 24, color: 0xff7a20, speed: 3, life: 0.5, size: 0.3, lift: 0 })
          }
          break
        }
        case 'howl':
          this.shake = Math.max(this.shake, 0.9)
          break
        case 'latch':
          this.shake = Math.max(this.shake, 0.7)
          break
        case 'drain': {
          const m = this.models.get(ev.id)
          if (m) this.particles.burst(this.lanternGlow.getWorldPosition(this.tmpV), { count: 20, color: 0xff5a20, speed: 1.5, life: 0.6, size: 0.15, lift: 0 })
          break
        }
        case 'boss-attack':
          if (ev.attack === 'quake') this.shake = Math.max(this.shake, 1.6)
          else if (ev.attack === 'howl') this.shake = Math.max(this.shake, 1)
          break
        case 'call':
        case 'mimic': {
          const m = this.models.get(ev.id)
          if (m) {
            m.flash = 1
            this.particles.burst(m.group.position, { count: 30, color: ev.kind === 'call' ? 0xffa040 : 0xb070ff, speed: 2.5, life: 0.8, size: 0.3, lift: 0.4 })
          }
          break
        }
        case 'escape': {
          const m = this.models.get(ev.id)
          if (m) this.particles.burst(m.group.position, { count: 40, color: GOLD, speed: 2, life: 1.2, size: 0.3, lift: 1.5 })
          break
        }
        case 'dash': {
          const m = this.models.get(ev.id)
          this.shake = Math.max(this.shake, 0.35)
          if (m) this.particles.burst(m.group.position, { count: 30, color: 0xff5a3a, speed: 4, life: 0.5, size: 0.3, lift: 0 })
          break
        }
        case 'blink': {
          // 消えた場所と、現れた場所に紫の煙
          this.particles.burst(this.tmpV.set(ev.x, 1.35, ev.fromZ), { count: 30, color: 0x9a6aff, speed: 2, life: 0.8, size: 0.35, lift: 0.4 })
          this.particles.burst(this.tmpV.set(ev.x, 1.35, ev.toZ), { count: 30, color: 0xc8a0ff, speed: 2.5, life: 0.7, size: 0.35, lift: 0.4 })
          break
        }
        case 'ambush': {
          // 茂みから飛び出す: 葉っぱが散って、画面が少し揺れる
          const m = this.models.get(ev.id)
          this.shake = Math.max(this.shake, 0.5)
          if (m) m.flash = 1
          break
        }
        case 'armor': {
          const m = this.models.get(ev.id)
          if (m) {
            m.flash = 1
            m.pulse = 2
            this.particles.burst(m.group.position, { count: 40, color: 0xb0a898, speed: 3.5, life: 0.9, size: 0.3, lift: -1.5 })
          }
          break
        }
        case 'bell': {
          this.bellTime = 0
          this.bellRing.visible = true
          this.shake = 0.4
          for (const m of this.models.values()) {
            m.flash = 1
            this.particles.burst(m.group.position, { count: 24, color: 0xffe2a0, speed: 3, life: 1.2, size: 0.3, lift: 0.3 })
          }
          break
        }
        case 'heal': {
          const at = this.lanternGlow.getWorldPosition(this.tmpV)
          this.particles.burst(at, { count: 40, color: 0xffc860, speed: 1.6, life: 1.4, size: 0.12, lift: 0.4 })
          break
        }
      }
    }
  }

  /** 1 歩踏み出したか（足音を鳴らすため。呼ぶと合図は消える） */
  stepTaken(): boolean {
    const s = this.stepPending
    this.stepPending = false
    return s
  }

  /** 打鍵の手応え: カメラをほんの少し揺らす */
  kick(amount = 0.06): void {
    this.shake = Math.max(this.shake, amount)
  }

  /**
   * 確認用: 影の形を目の前に並べる（タイトルの森を `#shades` 付きで開くと呼ばれる）。
   * シェーダー（shade.ts）の形を直したときに、全部の形を一度に見比べるためのもの。
   */
  showGallery(shapes: readonly ShapeName[]): void {
    this.gallery = true
    this.decor = shapes.map((shape, i) => {
      const id = -100 - i
      this.forcedShape.set(id, shape)
      const cols = 5
      const x = ((i % cols) - (cols - 1) / 2) * -2.7 // 右が -x なので、左から右へ並ぶよう符号を反転
      const z = 8 + Math.floor(i / cols) * 5
      return { id, kind: 'shade' as const, x, z, baseX: x, baseZ: z, phase: 0 }
    })
  }

  /** 影の頭の上（言葉の札を出す場所）の画面上の位置。後ろ・画面外なら null */
  labelPosition(e: Enemy, width: number, height: number): { x: number; y: number } | null {
    const m = this.models.get(e.id)
    const top = e.kind === 'boss' ? 8.2 : e.kind === 'fox' ? 2.3 : 2.7
    const v = this.tmpV.set(e.x, (m ? m.group.position.y - (e.kind === 'boss' ? 3.6 : 1.35) : 0) + top, e.z)
    v.project(this.camera)
    if (v.z > 1) return null
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height }
  }

  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    // 縦長の画面（スマホ）では横が狭くなるので、画角を広げて影が画面に収まるようにする
    this.camera.fov = w < h ? 80 : 62
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    for (const m of this.models.values()) (m.body.material as THREE.Material).dispose()
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    this.particles.dispose()
    this.fireflies.dispose()
    this.composer?.dispose()
    disposeTextures()
    this.renderer.dispose()
  }
}
