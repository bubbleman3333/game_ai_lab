// 近くの通行人・警官・野次馬を、骨格とアニメーションのついた人のモデル（public/city/people/*.glb）で描く。
//
// モデルは Quaternius の「Ultimate Modular Men / Women Pack」（CC0）。全員が同じ骨格と同じ 24 種類の動き
// （Walk・Run・Idle・Death・HitRecieve・Wave・Idle_Gun_Pointing など）を持っている。
//
// 骨格つきのモデルは 1 人ずつ描くので重い。そこで、自分に近い MAX_NEAR 人だけをこのモデルにして、
// 遠くの人はこれまでの軽いモデル（pedModels.ts、InstancedMesh）で描く。人が近づいたり離れたりするたびに、
// モデルを使い回す（プールから出し入れする）。

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { Ped } from '../sim/pedestrians'
import { isFemale } from '../sim/pedestrians'

const BASE = `${import.meta.env.BASE_URL}city/people/`
const MEN = ['m_casual_character', 'm_business_man', 'm_hoodie_character', 'm_worker', 'm_punk', 'm_beach_character', 'm_farmer']
const WOMEN = ['f_suit', 'f_worker', 'f_animated_woman', 'f_punk']
const OFFICERS = { male: 'm_swat', female: 'f_soldier' }
/** 骨格つきで描く人数（近い順） */
export const MAX_NEAR = 36
const NEAR_RANGE = 75
const HEIGHT = 1.72 // モデルをこの背の高さ（m）にそろえる

type Clip = 'Walk' | 'Run' | 'Idle' | 'Idle_Neutral' | 'Death' | 'HitRecieve' | 'Wave' | 'Idle_Gun_Pointing' | 'Interact'

interface Template {
  scene: THREE.Group
  clips: Map<string, THREE.AnimationClip>
  scale: number
}

interface Actor {
  model: string
  root: THREE.Object3D
  inner: THREE.Object3D
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  current: string
  pedId: number
  lastMode: string
}

export class PedSkinned {
  readonly group = new THREE.Group()
  private templates = new Map<string, Template>()
  private free = new Map<string, Actor[]>()
  private active = new Map<number, Actor>()
  private loading = false
  ready = false

  /** モデルを読み込む（読み込み終わるまでは、全員を軽いモデルで描く） */
  load(): void {
    if (this.loading) return
    this.loading = true
    const loader = new GLTFLoader()
    const names = [...MEN, ...WOMEN, OFFICERS.male, OFFICERS.female]
    let left = names.length
    for (const name of names) {
      loader.load(`${BASE}${name}.glb`, (gltf) => {
        const scene = gltf.scene
        scene.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          m.castShadow = true
          m.receiveShadow = true
          m.frustumCulled = false
          // 素材は面ごとの角ばった陰影（ローポリ風）なので、頂点をつなぎ直してなめらかな陰影にする
          const g = m.geometry
          g.deleteAttribute('normal')
          const smooth = mergeVertices(g, 1e-4)
          smooth.computeVertexNormals()
          m.geometry = smooth
          g.dispose()
        })
        const box = new THREE.Box3().setFromObject(scene)
        const h = box.max.y - box.min.y || 1
        const clips = new Map<string, THREE.AnimationClip>()
        for (const c of gltf.animations) clips.set(c.name.replace(/^.*\|/, ''), c)
        this.templates.set(name, { scene, clips, scale: HEIGHT / h })
        if (--left === 0) this.ready = true
      }, undefined, () => { if (--left === 0) this.ready = this.templates.size > 0 })
    }
  }

  /** その人をどのモデルで描くか（人ごとに決まる） */
  private modelFor(p: Ped): string {
    if (p.officer) return isFemale(p) && p.id % 3 === 0 ? OFFICERS.female : OFFICERS.male
    const list = isFemale(p) ? WOMEN : MEN
    return list[p.id % list.length]
  }

  private take(model: string): Actor | null {
    const pool = this.free.get(model)
    const a = pool?.pop()
    if (a) { a.root.visible = true; return a }
    const t = this.templates.get(model)
    if (!t) return null
    const inner = cloneSkinned(t.scene)
    inner.scale.setScalar(t.scale)
    // 服の色を少しずつ変える（同じモデルが並んでも見分けがつくように）
    const tint = new THREE.Color().setHSL(Math.random(), 0.15, 0.5)
    inner.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      m.material = mats.map((mm) => {
        const c = (mm as THREE.MeshStandardMaterial).clone()
        if (!/skin|eye|hair|brow|moustache/i.test(mm.name)) c.color.lerp(tint, 0.25)
        c.roughness = Math.max(c.roughness, 0.7)
        return c
      })
      if (m.material.length === 1) m.material = m.material[0]
    })
    const root = new THREE.Group()
    root.add(inner)
    this.group.add(root)
    const mixer = new THREE.AnimationMixer(inner)
    const actions = new Map<string, THREE.AnimationAction>()
    for (const [name, clip] of t.clips) actions.set(name, mixer.clipAction(clip))
    return { model, root, inner, mixer, actions, current: '', pedId: -1, lastMode: '' }
  }

  private give(a: Actor): void {
    a.root.visible = false
    a.mixer.stopAllAction()
    a.current = ''
    a.pedId = -1
    let pool = this.free.get(a.model)
    if (!pool) { pool = []; this.free.set(a.model, pool) }
    pool.push(a)
  }

  /** 動きを切り替える（少しずつ混ぜて、ぱっと切り替わらないように） */
  private play(a: Actor, clip: Clip, opts: { once?: boolean; speed?: number; fade?: number } = {}): void {
    const act = a.actions.get(clip) ?? a.actions.get('Idle')
    if (!act) return
    act.timeScale = opts.speed ?? 1
    if (a.current === clip) return
    const prev = a.actions.get(a.current)
    act.reset()
    act.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
    act.clampWhenFinished = !!opts.once
    act.play()
    if (prev) prev.crossFadeTo(act, opts.fade ?? 0.25, false)
    a.current = clip
  }

  /**
   * 近い人をモデルで描く。戻り値は、モデルで描いた人の番号（軽いモデルのほうでは描かない）
   */
  update(dt: number, peds: Ped[], cx: number, cz: number, chasing: boolean, groundY: (x: number, z: number) => number): Set<number> {
    const shown = new Set<number>()
    if (!this.ready) return shown
    const near = peds.map((p) => ({ p, d: Math.hypot(p.x - cx, p.z - cz) }))
      .filter((e) => e.d < NEAR_RANGE).sort((a, b) => a.d - b.d).slice(0, MAX_NEAR)
    const want = new Set(near.map((e) => e.p.id))
    for (const [id, a] of this.active) {
      if (!want.has(id)) { this.give(a); this.active.delete(id) }
    }
    for (const { p } of near) {
      let a = this.active.get(p.id)
      const model = this.modelFor(p)
      if (a && a.model !== model) { this.give(a); this.active.delete(p.id); a = undefined }
      if (!a) {
        const t = this.take(model)
        if (!t) continue
        a = t
        a.pedId = p.id
        a.lastMode = ''
        this.active.set(p.id, a)
      }
      shown.add(p.id)
      this.pose(a, p, dt, chasing, groundY)
    }
    return shown
  }

  private pose(a: Actor, p: Ped, dt: number, chasing: boolean, groundY: (x: number, z: number) => number): void {
    const moving = Math.hypot(p.tx - p.x, p.tz - p.z) > 0.25
    const justChanged = a.lastMode !== p.mode
    a.lastMode = p.mode
    // 倒れるときは、倒れる動き（Death）そのものに任せ、体を回すのは空中を飛んでいるあいだだけ
    let tilt = 0
    switch (p.mode) {
      case 'walk': case 'cross': case 'return':
        this.play(a, 'Walk', { speed: p.walkSpeed / 1.3 })
        break
      case 'flee':
        this.play(a, 'Run', { speed: 1.05 })
        break
      case 'wait':
        this.play(a, 'Idle')
        break
      case 'watch':
        if (moving) this.play(a, 'Walk', { speed: p.walkSpeed / 1.3 })
        else this.play(a, p.id % 3 === 0 ? 'Wave' : p.id % 3 === 1 ? 'Interact' : 'Idle_Neutral')
        break
      case 'officer':
        if (moving) this.play(a, p.officer?.run ? 'Run' : 'Walk')
        else this.play(a, chasing ? 'Idle_Gun_Pointing' : 'Idle')
        break
      case 'stagger':
        this.play(a, 'HitRecieve', { once: true, fade: 0.08 })
        break
      case 'fly':
        this.play(a, 'HitRecieve_2' as Clip, { once: true, fade: 0.05 })
        tilt = p.tilt
        break
      case 'down':
        if (justChanged || a.current !== 'Death') this.play(a, 'Death', { once: true, fade: 0.1 })
        break
    }
    const y = (p.mode === 'fly' ? p.y : 0) + groundY(p.x, p.z)
    a.root.position.set(p.x, y, p.z)
    a.root.rotation.set(0, 0, 0)
    if (tilt) {
      const axis = new THREE.Vector3(Math.cos(p.fallYaw), 0, -Math.sin(p.fallYaw))
      a.root.quaternion.setFromAxisAngle(axis, tilt)
      a.root.rotateY(p.yaw)
    } else {
      a.root.rotation.y = p.mode === 'down' ? p.fallYaw + Math.PI : p.yaw
    }
    const s = p.look.height
    a.root.scale.set(p.look.width * s, s, p.look.width * s)
    a.mixer.update(dt)
  }

  dispose(): void {
    for (const a of this.active.values()) a.mixer.stopAllAction()
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mm of mats) mm.dispose()
    })
    for (const t of this.templates.values()) {
      t.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose() })
    }
  }
}
