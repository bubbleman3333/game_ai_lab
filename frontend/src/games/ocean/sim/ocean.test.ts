// 海を泳ぐゲームの進行（sim/game.ts）のテスト。種を固定しているので毎回同じ海になる。

import { describe, expect, it } from 'vitest'
import {
  type GameEvent, type Input, LANE, MAX_AIR, MAX_DEPTH, MAX_HP, NO_INPUT, OceanGame, SWIM_SPEED,
} from './game'
import { ZONES, zoneAt } from './zones'

/** seconds 秒ぶん、小刻みに進める */
function advance(game: OceanGame, seconds: number, input: Input | ((t: number) => Input) = NO_INPUT): GameEvent[] {
  const events: GameEvent[] = []
  for (let t = 0; t < seconds; t += 1 / 60) {
    events.push(...game.update(1 / 60, typeof input === 'function' ? input(t) : input))
  }
  return events
}

/** クラゲにもサメにも触れないよう、無敵にしたまま進める（距離のテスト用） */
function invincible(game: OceanGame): void {
  game.player.invuln = 1e9
}

describe('泳ぐ', () => {
  it('前に進み続け、距離が伸びる', () => {
    const game = new OceanGame(1)
    invincible(game)
    advance(game, 10)
    expect(game.distance).toBeGreaterThan(SWIM_SPEED * 8)
    expect(game.distance).toBeLessThan(SWIM_SPEED * 10.5)
  })

  it('ダッシュすると速いが、スタミナが減る', () => {
    const slow = new OceanGame(1)
    const fast = new OceanGame(1)
    invincible(slow); invincible(fast)
    advance(slow, 5)
    advance(fast, 5, { ...NO_INPUT, dash: true })
    expect(fast.distance).toBeGreaterThan(slow.distance * 1.3)
    expect(fast.player.stamina).toBeLessThan(slow.player.stamina)
  })

  it('右に動くと x が減り（右 = -x）、範囲の外には出ない', () => {
    const game = new OceanGame(1)
    invincible(game)
    advance(game, 2, { ...NO_INPUT, steer: 1 })
    expect(game.player.x).toBeLessThan(-3)
    advance(game, 20, { ...NO_INPUT, steer: 1 })
    expect(game.player.x).toBeGreaterThanOrEqual(-LANE)
    advance(game, 30, { ...NO_INPUT, steer: -1 })
    expect(game.player.x).toBeLessThanOrEqual(LANE)
  })

  it('潜ると息が減り、離すと浮いて息が戻る', () => {
    const game = new OceanGame(1)
    invincible(game)
    const ev = advance(game, 4, { ...NO_INPUT, dive: true })
    expect(game.player.y).toBeLessThan(-3)
    expect(game.player.y).toBeGreaterThanOrEqual(MAX_DEPTH)
    expect(game.player.air).toBeLessThan(MAX_AIR)
    expect(ev.some((e) => e.kind === 'submerge')).toBe(true)
    const ev2 = advance(game, 6)
    expect(game.player.y).toBe(0)
    expect(game.player.air).toBe(MAX_AIR)
    expect(ev2.some((e) => e.kind === 'surface')).toBe(true)
  })

  it('浅瀬では海底の上で止まり、沖合ではもっと深く潜れる', () => {
    const shallow = new OceanGame(1)
    invincible(shallow)
    advance(shallow, 12, { ...NO_INPUT, dive: true })
    expect(shallow.player.y).toBeGreaterThan(ZONES[0].floorY)
    expect(shallow.player.y).toBeLessThan(-8)
    const deep = new OceanGame(1)
    invincible(deep)
    deep.player.z = ZONES[1].from + 1
    advance(deep, 12, { ...NO_INPUT, dive: true })
    expect(deep.player.y).toBeLessThan(shallow.player.y - 5)
    expect(deep.player.y).toBeGreaterThanOrEqual(MAX_DEPTH)
  })

  it('深いところの真珠は点が高い', () => {
    const game = new OceanGame(1)
    invincible(game)
    game.pearls.length = 0
    game.player.y = -20
    game.player.z = ZONES[1].from + 1
    game.pearls.push({ id: 999, x: 0, y: -20, z: game.player.z + 0.5, phase: 0, value: 40 })
    const ev = advance(game, 0.5, { ...NO_INPUT, dive: true })
    expect(ev.find((e) => e.kind === 'pearl')?.value).toBe(40)
    expect(game.pearlScore).toBe(40)
  })

  it('息が切れたまま潜り続けると体力が減り、やがて溺れる', () => {
    const game = new OceanGame(1)
    invincible(game)
    const ev = advance(game, 70, { ...NO_INPUT, dive: true })
    expect(ev.filter((e) => e.kind === 'drowning').length).toBeGreaterThan(0)
    expect(game.dead).toBe(true)
    expect(game.cause).toBe('drown')
  })
})

describe('クラゲ', () => {
  it('触れると刺され、少しのあいだ無敵になる', () => {
    const game = new OceanGame(1)
    // 目の前にクラゲを置く
    game.jellies.length = 0
    game.jellies.push({ id: 999, x: 0, y: -0.5, z: 3, size: 1, phase: 0, kind: 0 })
    const ev = advance(game, 1.5)
    const stings = ev.filter((e) => e.kind === 'sting')
    expect(stings).toHaveLength(1)
    expect(game.player.hp).toBe(MAX_HP - 1)
    expect(game.stings).toBe(1)
  })

  it('前方に群れが置かれ、後ろに流れたものは消える', () => {
    const game = new OceanGame(2)
    invincible(game)
    expect(game.jellies.length).toBeGreaterThan(0)
    advance(game, 30)
    for (const j of game.jellies) expect(j.z).toBeGreaterThan(game.player.z - 31)
    for (const j of game.jellies) expect(j.z).toBeLessThan(game.player.z + 200)
  })
})

describe('真珠', () => {
  it('拾うと得点が増える', () => {
    const game = new OceanGame(1)
    invincible(game)
    game.pearls.length = 0
    game.pearls.push({ id: 999, x: 0, y: 0, z: 3, phase: 0, value: 10 })
    const ev = advance(game, 2)
    expect(ev.filter((e) => e.kind === 'pearl')).toHaveLength(1)
    expect(game.pearlsTaken).toBe(1)
    expect(game.score).toBeGreaterThanOrEqual(Math.floor(game.distance) + 10)
  })
})

describe('サメ', () => {
  /** サメが現れて「うろつき」に入るまで待つ（クラゲに当たらないよう無敵で） */
  function waitForShark(game: OceanGame): GameEvent[] {
    invincible(game)
    const ev: GameEvent[] = []
    for (let i = 0; i < 240; i++) {
      ev.push(...advance(game, 0.5))
      if (game.sharks.length === 1 && game.sharks[0].state === 'stalk') break
    }
    expect(ev.some((e) => e.kind === 'shark-warn')).toBe(true)
    expect(game.sharks).toHaveLength(1)
    return ev
  }

  it('しばらくうろついてから突っ込み、避けなければ噛まれる', () => {
    const game = new OceanGame(3)
    waitForShark(game)
    const id = game.sharks[0].id
    game.player.invuln = 0
    const ev = advance(game, 45)
    expect(ev.some((e) => e.kind === 'shark-charge')).toBe(true)
    expect(ev.some((e) => e.kind === 'bite')).toBe(true)
    expect(game.bites).toBeGreaterThan(0)
    expect(game.player.hp).toBeLessThan(MAX_HP)
    // 来襲が終わると去る（そのあと別のサメが来ていてもよい）
    expect(ev.some((e) => e.kind === 'shark-leave')).toBe(true)
    expect(game.sharks.some((s) => s.id === id)).toBe(false)
  })

  it('突っ込みの瞬間に横へ避けると、噛まれずにかわせる', () => {
    let dodgedAny = false
    // 種によって来る向きが違うので、いくつか試して 1 つでもかわせればよい
    for (const seed of [3, 4, 5, 6, 7]) {
      const game = new OceanGame(seed)
      waitForShark(game)
      game.player.invuln = 0
      // 突っ込みが始まった瞬間に、サメから見て横へ逃げる向きを 1 回決めて、そのまま動き続ける
      let steer = 0
      const ev = advance(game, 30, () => {
        const s = game.sharks[0]
        if (!s || s.state !== 'charge') { steer = 0; return NO_INPUT }
        if (steer === 0) {
          // サメの右向きは (-cos yaw, sin yaw)。こちらがサメの右にいれば右へ（steer = +1）、左なら左へ
          const side = -Math.cos(s.yaw) * (game.player.x - s.x) + Math.sin(s.yaw) * (game.player.z - s.z)
          steer = side >= 0 ? 1 : -1
        }
        return { ...NO_INPUT, steer }
      })
      if (ev.some((e) => e.kind === 'dodge') && !ev.some((e) => e.kind === 'bite')) dodgedAny = true
    }
    expect(dodgedAny).toBe(true)
  })

  it('目の前まで来たときに蹴ると追い払える', () => {
    const game = new OceanGame(3)
    waitForShark(game)
    game.player.invuln = 0
    const ev = advance(game, 30, () => {
      const s = game.sharks[0]
      if (!s || s.state !== 'charge') return NO_INPUT
      const d = Math.hypot(s.x - game.player.x, s.z - game.player.z)
      return { ...NO_INPUT, kick: d < 3.2 }
    })
    expect(ev.some((e) => e.kind === 'punch')).toBe(true)
    expect(ev.some((e) => e.kind === 'bite')).toBe(false)
    expect(game.punches).toBe(1)
    expect(game.sharks).toHaveLength(0)
  })

  it('体力が尽きるとサメが死因になる', () => {
    const game = new OceanGame(3)
    game.player.hp = 2
    waitForShark(game)
    game.player.invuln = 0
    advance(game, 30)
    expect(game.dead).toBe(true)
    expect(game.cause).toBe('shark')
  })
})

describe('区間', () => {
  it('距離で区間が切り替わる', () => {
    expect(zoneAt(0).id).toBe('shallow')
    expect(zoneAt(ZONES[1].from).id).toBe('offshore')
    expect(zoneAt(99999).id).toBe(ZONES[ZONES.length - 1].id)
  })

  it('区間をまたぐと出来事が出る', () => {
    const game = new OceanGame(1)
    invincible(game)
    game.player.z = ZONES[1].from - 2
    const ev = advance(game, 2)
    expect(ev.filter((e) => e.kind === 'zone')).toHaveLength(1)
    expect(game.zone.id).toBe('offshore')
  })
})
