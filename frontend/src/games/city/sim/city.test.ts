// シティの計算（描画なし）が壊れていないかのテスト。
import { describe, expect, it } from 'vitest'
import { CityMap, blockCenter } from './cityMap'
import { Game, type Input } from './game'
import { SPECS, newBody, stepVehicle, speedOf, collideWorld } from './vehicle'

const NONE: Input = { throttle: 0, steer: 0, handbrake: false, horn: false, carjack: false, reset: false, timeSkip: false }

describe('車の物理', () => {
  it('アクセルで前へ進み、右に切ると右（yaw が減る向き）へ曲がる', () => {
    const b = newBody(0, 0, 0)
    for (let k = 0; k < 240; k++) stepVehicle(b, SPECS.sedan, { throttle: 1, steer: 0, handbrake: false }, 1 / 120)
    expect(b.z).toBeGreaterThan(5)
    expect(Math.abs(b.x)).toBeLessThan(0.01)
    for (let k = 0; k < 120; k++) stepVehicle(b, SPECS.sedan, { throttle: 0.3, steer: 1, handbrake: false }, 1 / 120)
    expect(b.yaw).toBeLessThan(-0.2)
    expect(b.x).toBeLessThan(0) // 右 = −x
  })

  it('最高速の近くで頭打ちになり、発散しない', () => {
    const b = newBody(0, 0, 0)
    for (let k = 0; k < 120 * 40; k++) stepVehicle(b, SPECS.sport, { throttle: 1, steer: 0, handbrake: false }, 1 / 120)
    const v = speedOf(b)
    expect(v).toBeGreaterThan(40)
    expect(v).toBeLessThan(SPECS.sport.vmax + 1)
  })

  it('全開で切り続けても、スピンして NaN になったりしない', () => {
    const b = newBody(0, 0, 0)
    for (let k = 0; k < 120 * 20; k++) {
      stepVehicle(b, SPECS.sport, { throttle: 1, steer: Math.sin(k / 50), handbrake: k % 300 < 60 }, 1 / 120)
    }
    expect(Number.isFinite(b.x + b.z + b.yaw + b.vx + b.vz)).toBe(true)
    expect(speedOf(b)).toBeLessThan(80)
  })

  it('建物の壁を通り抜けない', () => {
    const map = new CityMap()
    const B = map.buildings[0]
    const cz = (B.z0 + B.z1) / 2
    const b = newBody(B.x0 - 8, cz, Math.PI / 2) // +x 向き = 建物へ向かう
    const broken = new Uint8Array(map.props.length)
    for (let k = 0; k < 120 * 4; k++) {
      stepVehicle(b, SPECS.sedan, { throttle: 1, steer: 0, handbrake: false }, 1 / 120)
      collideWorld(b, SPECS.sedan, map, broken)
    }
    expect(b.x).toBeLessThan(B.x0)
  })
})

describe('街', () => {
  it('道路・歩道・土地を正しく見分ける', () => {
    const map = new CityMap()
    const c = blockCenter(3)
    expect(map.surface(c, c)).not.toBe('road')
    expect(map.surface(c + 47, c)).toBe('road') // 区画の間の道
    expect(map.surface(c + 37, c)).toBe('sidewalk')
  })

  it('信号は同じ交差点で両方向が同時に青にならない', () => {
    for (let t = 0; t < 60; t += 0.25) {
      const a = CityMap.light(3, 4, 0, t)
      const b = CityMap.light(3, 4, 1, t)
      expect(a === 'green' && b === 'green').toBe(false)
    }
  })
})

describe('ゲーム全体', () => {
  it('しばらく進めても壊れず、一般車が走り、人が歩いている', () => {
    const g = new Game()
    const start = g.vehicles.filter((v) => v.lane).map((v) => [v.id, v.body.x, v.body.z] as const)
    for (let k = 0; k < 60 * 30; k++) g.update(1 / 60, NONE)
    expect(g.peds.list.length).toBeGreaterThan(60)
    const moved = start.filter(([id, x, z]) => {
      const v = g.vehicles.find((w) => w.id === id)
      return v && Math.hypot(v.body.x - x, v.body.z - z) > 40
    })
    expect(moved.length).toBeGreaterThan(5)
    for (const v of g.vehicles) expect(Number.isFinite(v.body.x + v.body.z)).toBe(true)
    // 一般車どうしが勝手にぶつかって止まりまくっていないこと
    const wrecked = g.vehicles.filter((v) => v.hazard && v.role === 'traffic')
    expect(wrecked.length).toBeLessThan(5)
  })

  it('人をはねると手配度が上がり、パトカーが来る', () => {
    const g = new Game()
    const me = g.player
    // 目の前に人を置いて突っ込む
    for (let n = 0; n < 4; n++) {
      const p = g.peds.list[n]
      p.mode = 'flee'; p.timer = 99
      p.x = me.body.x + Math.sin(me.body.yaw) * (8 + n * 3)
      p.z = me.body.z + Math.cos(me.body.yaw) * (8 + n * 3)
    }
    let hits = 0
    for (let k = 0; k < 60 * 3; k++) {
      for (const e of g.update(1 / 60, { ...NONE, throttle: 1 })) if (e.kind === 'pedHit' && e.player) hits++
    }
    expect(hits).toBeGreaterThan(0)
    expect(g.stars).toBeGreaterThan(0)
    let chased = false
    for (let k = 0; k < 60 * 12; k++) {
      g.update(1 / 60, NONE)
      chased ||= g.vehicles.some((v) => v.role === 'police' && v.police !== null)
    }
    expect(chased).toBe(true)
  })
})

describe('物語と街', () => {
  it('4 つの街がどれも作れて、物語の輪は街の中にある', async () => {
    const { MAPS } = await import('./maps')
    const { CHAPTERS } = await import('./story')
    for (const cfg of MAPS) {
      const g = new Game(cfg, { chapter: CHAPTERS.findIndex((c) => c.map === cfg.id), step: 0 })
      expect(g.map.buildings.length).toBeGreaterThan(100)
      const ch = CHAPTERS.find((c) => c.map === cfg.id)!
      for (const s of ch.steps) {
        expect(s.at[0]).toBeLessThanOrEqual(cfg.blocks)
        expect(s.at[1]).toBeLessThanOrEqual(cfg.blocks)
      }
      expect(g.storyTarget).not.toBeNull()
      for (let k = 0; k < 60; k++) g.update(1 / 60, NONE)
    }
  })

  it('物語の輪に入ると会話が流れ、標的を壊すと次へ進む', async () => {
    const { MAPS } = await import('./maps')
    const g = new Game(MAPS[0], { chapter: 0, step: 3 }) // 第 1 章の「裏切り者を追え」
    const m = g.storyTarget!
    g.player.body.x = m.x
    g.player.body.z = m.z
    const ev = g.update(1 / 60, NONE)
    expect(ev.some((e) => e.kind === 'dialogue')).toBe(true)
    expect(g.mission?.def.kind).toBe('takedown')
    const target = g.vehicles.find((v) => v.id === g.targetVehicle)!
    target.health = -1
    target.burning = 0.01
    let progressed = false
    for (let k = 0; k < 30; k++) {
      for (const e of g.update(1 / 60, NONE)) if (e.kind === 'story') progressed = e.chapterDone
    }
    expect(progressed).toBe(true)
    expect(g.progress).toEqual({ chapter: 1, step: 0 })
  })
})

describe('職務質問', () => {
  it('長く止まっているとパトカーが来て職質され、待てば解放か手配になる', () => {
    const g = new Game()
    const phases: string[] = []
    for (let k = 0; k < 60 * 90; k++) {
      for (const e of g.update(1 / 60, NONE)) if (e.kind === 'questioning') phases.push(e.phase)
      if (phases.length >= 2) break
    }
    expect(phases[0]).toBe('start')
    expect(['released', 'found']).toContain(phases[1])
  })
})

describe('海とヘリ', () => {
  it('護岸に速く突っ込むと海に落ちて水没する', async () => {
    const { SEAWALL } = await import('./cityMap')
    const g = new Game()
    const b = g.player.body
    b.x = SEAWALL - 20; b.z = 0; b.yaw = Math.PI / 2; b.vx = 25; b.vz = 0
    let splash = false
    for (let k = 0; k < 60 * 3; k++) for (const e of g.update(1 / 60, { ...NONE, throttle: 1 })) if (e.kind === 'splash' && e.player) splash = true
    expect(splash).toBe(true)
    expect(g.state).toBe('wasted')
    expect(g.deathReason).toBe('water')
  })

  it('手配度 4 でヘリが来て撃ってくる', () => {
    const g = new Game()
    g.setStars(4)
    let shots = 0
    for (let k = 0; k < 60 * 25; k++) for (const e of g.update(1 / 60, NONE)) if (e.kind === 'shot') shots++
    expect(g.heli).not.toBeNull()
    expect(shots).toBeGreaterThan(0)
  })
})

describe('店を壊す', () => {
  it('店に突っ込むとショーウィンドウを突き破って、壊した跡が残る', () => {
    const g = new Game()
    const B = g.map.buildings.find((b) => b.shop && b.x1 - b.x0 > 12)!
    const b = g.player.body
    b.x = B.x0 - 10; b.z = (B.z0 + B.z1) / 2; b.yaw = Math.PI / 2; b.vx = 15; b.vz = 0
    let smashed = false
    for (let k = 0; k < 60 * 2; k++) for (const e of g.update(1 / 60, { ...NONE, throttle: 1 })) if (e.kind === 'shopSmash') smashed = true
    expect(smashed).toBe(true)
    expect(g.smashed.length).toBeGreaterThan(0)
    expect(b.x + 2.2).toBeGreaterThan(B.x0 + 1) // 車の鼻先がガラスの奥までめり込んでいる
    expect(b.x).toBeLessThan(B.x0 + 1.6 + 2.5)
  })
})
