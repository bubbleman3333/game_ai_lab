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

import * as THREE from 'three'
import { type Enemy, type GameEvent, MAX_OIL, type TypingGame } from '../sim/game'
import { AmbientFireflies, Particles } from './particles'
import { disposeTextures, foxFireTexture, glowTexture, moonTexture, shadeBodyTexture, shadeEyesTexture } from './textures'
import { type Theme, themeFor } from './themes'

const EYE_HEIGHT = 1.6
/** 木を並べる奥行き（m）。これより奥へ行ったら手前に戻す */
const TREE_RANGE = 130
const FIREFLY = 0xc8ff6a
const EYE_IDLE = new THREE.Color(0xffe9a8)
const EYE_LOCK = new THREE.Color(0xff5a3a)

interface EnemyModel {
  group: THREE.Group
  body: THREE.Sprite
  eyes: THREE.Sprite | null
  kind: Enemy['kind']
  size: number
  /** 打たれた・傷ついたときに一瞬ふくらむ */
  pulse: number
  bob: number
}

interface Scenery {
  x: number
  z: number
  s: number
  r: number
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
  private torii: THREE.Group[] = []
  private stoneLanterns: THREE.Group[] = []
  private fireflies: AmbientFireflies
  private particles = new Particles(1400)
  private models = new Map<number, EnemyModel>()
  private time = 0
  private shake = 0
  private walkSpeed = 0
  private dawn = 0
  private dummy = new THREE.Object3D()
  private tmpV = new THREE.Vector3()
  private tmpC = new THREE.Color()

  constructor(canvas: HTMLCanvasElement, themeId: string) {
    this.theme = themeFor(themeId)
    const t = this.theme
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
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
        map: glowTexture(), color: t.moon, fog: false, depthWrite: false, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending,
      }))
      halo.position.copy(moon.position)
      halo.scale.setScalar(t.moonSize * 22)
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

    this.fireflies = new AmbientFireflies(150, FIREFLY)
    this.scene.add(this.fireflies.points, this.particles.points)
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
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12), new THREE.MeshBasicMaterial({ color: this.theme.lantern }))
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

  private buildMushrooms(): { items: Scenery[]; mesh: THREE.InstancedMesh } {
    const n = 70
    const items: Scenery[] = []
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1
      items.push({ x: side * (2.4 + Math.random() * 6), z: Math.random() * TREE_RANGE - 6, s: 0.6 + Math.random() * 0.8, r: 0 })
    }
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x6affd8 }), n)
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
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.32, 0.4), new THREE.MeshBasicMaterial({ color: 0xffa040 }))
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

  private buildEnemy(e: Enemy): EnemyModel {
    const group = new THREE.Group()
    let body: THREE.Sprite
    let eyes: THREE.Sprite | null = null
    let size: number
    if (e.kind === 'fox') {
      size = 1.1
      body = new THREE.Sprite(new THREE.SpriteMaterial({
        map: foxFireTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }))
      body.scale.set(size, size * 1.4, 1)
    } else {
      size = e.kind === 'boss' ? 7.5 : 2.1
      body = new THREE.Sprite(new THREE.SpriteMaterial({ map: shadeBodyTexture(), transparent: true, depthWrite: false }))
      body.scale.setScalar(size)
      eyes = new THREE.Sprite(new THREE.SpriteMaterial({
        map: shadeEyesTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        color: e.kind === 'boss' ? 0xff4a3a : EYE_IDLE,
      }))
      eyes.scale.setScalar(size)
      eyes.position.z = -0.01
      group.add(eyes)
    }
    group.add(body)
    this.scene.add(group)
    return { group, body, eyes, kind: e.kind, size, pulse: 0, bob: Math.random() * 10 }
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
    for (const g of [...this.torii, ...this.stoneLanterns]) {
      g.position.z -= walked
      if (g.position.z < -8) g.position.z += this.torii.includes(g) ? 26 * this.torii.length : 14 * (this.stoneLanterns.length / 2)
    }
  }

  update(dt: number, game: TypingGame): void {
    this.time += dt
    // 影がいないあいだは奥へ歩き、影がいるときは足を止めぎみにする
    const targetWalk = game.over ? 0 : game.enemies.length === 0 ? 2.4 : 0.35
    this.walkSpeed += (targetWalk - this.walkSpeed) * Math.min(1, dt * 1.5)
    const walked = this.walkSpeed * dt
    this.placeScenery(walked)

    // ランタン: 油が少ないほど暗く、コンボが続くほど明るい。ゆらゆら揺れる
    const oil = game.oil / MAX_OIL
    const comboBoost = Math.min(1, game.combo / 60)
    const flick = 0.9 + 0.1 * Math.sin(this.time * 13) * Math.sin(this.time * 7.3)
    const level = (0.35 + 0.65 * oil) * (1 + comboBoost * 0.8) * flick
    this.lanternLight.intensity = 14 * level
    this.lanternLight.distance = 20 + 14 * comboBoost
    this.lanternGlow.scale.setScalar(0.3 + 0.25 * level)
    this.lanternCore.material.color.set(this.theme.lantern).multiplyScalar(0.5 + 0.5 * Math.min(1.3, level))

    // カメラ: 歩くと少し上下し、襲われると揺れる
    this.shake = Math.max(0, this.shake - dt * 2.5)
    const bob = Math.sin(this.time * 6) * 0.04 * Math.min(1, this.walkSpeed)
    const sx = (Math.random() - 0.5) * this.shake * 0.5, sy = (Math.random() - 0.5) * this.shake * 0.5
    this.camera.position.set(sx, EYE_HEIGHT + bob + sy, 0)
    this.camera.lookAt(sx * 0.5, EYE_HEIGHT - 0.1 + bob, 10)

    // 終章: ボスを削るほど空が明けていく
    const t = this.theme
    if (t.dawnTop !== undefined && t.dawnBottom !== undefined) {
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

    this.syncEnemies(dt, game)
    this.fireflies.update(dt, walked, game.result === 'clear' ? 1 : 0.55 + 0.45 * comboBoost)
    this.particles.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  private syncEnemies(dt: number, game: TypingGame): void {
    const alive = new Set<number>()
    for (const e of game.enemies) {
      alive.add(e.id)
      let m = this.models.get(e.id)
      if (!m) {
        m = this.buildEnemy(e)
        this.models.set(e.id, m)
      }
      m.bob += dt
      m.pulse = Math.max(0, m.pulse - dt * 4)
      const y = e.kind === 'boss' ? 3.4 : e.kind === 'fox' ? 1.3 : 1.25
      m.group.position.set(e.x, y + Math.sin(m.bob * 2) * (e.kind === 'fox' ? 0.25 : 0.12), e.z)
      const s = m.size * (1 + m.pulse * 0.18)
      if (m.kind === 'fox') m.body.scale.set(s, s * 1.4 * (1 + Math.sin(m.bob * 15) * 0.06), 1)
      else m.body.scale.setScalar(s)
      if (m.eyes) {
        m.eyes.scale.setScalar(s)
        if (m.kind !== 'boss') m.eyes.material.color.copy(game.target === e ? EYE_LOCK : EYE_IDLE)
        // 近いほど目が強く光る
        m.eyes.material.opacity = Math.min(1, 0.4 + (1 - e.z / 30) * 0.9)
      }
    }
    for (const [id, m] of this.models) {
      if (!alive.has(id)) {
        this.scene.remove(m.group)
        m.body.material.dispose()
        m.eyes?.material.dispose()
        this.models.delete(id)
      }
    }
  }

  /** 出来事に合わせた演出（光の粒・画面の揺れ） */
  handleEvents(events: GameEvent[], game: TypingGame): void {
    for (const ev of events) {
      switch (ev.kind) {
        case 'key': {
          const m = this.models.get(ev.id)
          if (m) {
            m.pulse = 1
            this.particles.burst(m.group.position, { count: 2, color: 0xffd27a, speed: 1.2, life: 0.5, size: 0.2, lift: 0 })
          }
          break
        }
        case 'kill': {
          const at = this.tmpV.set(ev.x, ev.enemy === 'boss' ? 3.4 : 1.3, ev.z)
          const boss = ev.enemy === 'boss'
          this.particles.burst(at, { count: boss ? 420 : 48, color: FIREFLY, speed: boss ? 7 : 2.6, life: boss ? 5 : 2.6, size: boss ? 0.5 : 0.35, lift: 0.8 })
          this.particles.burst(at, { count: boss ? 80 : 12, color: 0xffffff, speed: boss ? 9 : 3.5, life: 0.6, size: 0.3, lift: 0 })
          break
        }
        case 'boss-hurt': {
          const m = this.models.get(ev.id)
          if (m) {
            m.pulse = 2
            this.particles.burst(m.group.position, { count: 90, color: FIREFLY, speed: 5, life: 3, size: 0.4, lift: 0.8 })
          }
          break
        }
        case 'hit':
          this.shake = ev.damage > 1 ? 1.4 : 0.9
          break
        case 'heal': {
          const at = this.lanternGlow.getWorldPosition(this.tmpV)
          this.particles.burst(at, { count: 40, color: 0xffc860, speed: 1.6, life: 1.4, size: 0.12, lift: 0.4 })
          break
        }
      }
    }
    void game
  }

  /** 影の頭の上（言葉の札を出す場所）の画面上の位置。後ろ・画面外なら null */
  labelPosition(e: Enemy, width: number, height: number): { x: number; y: number } | null {
    const m = this.models.get(e.id)
    const top = e.kind === 'boss' ? 7.6 : e.kind === 'fox' ? 2.3 : 2.5
    const v = this.tmpV.set(e.x, (m ? m.group.position.y - (e.kind === 'boss' ? 3.4 : 1.25) : 0) + top, e.z)
    v.project(this.camera)
    if (v.z > 1) return null
    return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height }
  }

  resize(): void {
    const canvas = this.renderer.domElement
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    // 縦長の画面（スマホ）では横が狭くなるので、画角を広げて影が画面に収まるようにする
    this.camera.fov = w < h ? 80 : 62
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    this.particles.dispose()
    this.fireflies.dispose()
    disposeTextures()
    this.renderer.dispose()
  }
}
