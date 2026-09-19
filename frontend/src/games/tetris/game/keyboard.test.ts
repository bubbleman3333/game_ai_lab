// 押しっぱなしの横移動（DAS / ARR）のテスト。ブラウザなしで動かすため、キー入力と時刻は直接与える。

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameController } from '../engine'
import { KeyboardInput } from './keyboard'

/** 動いた回数だけ数える controller（壁までの距離を指定できる） */
function fakeController(room = 100) {
  const c = { moves: 0, act: (a: string) => (a === 'L' || a === 'R') && c.moves < room && ++c.moves > 0 }
  return c
}

function setup(handling: { dasMs: number; arrMs: number }, room = 100) {
  const c = fakeController(room)
  const k = new KeyboardInput(c as unknown as GameController, undefined, { ...handling, softDropMs: 20 })
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const input = k as unknown as { onDown(e: Partial<KeyboardEvent>): void }
  input.onDown({ code: 'ArrowLeft', repeat: false, preventDefault: () => undefined })
  // 60fps で時間を進める
  const advance = (ms: number) => {
    const end = now + ms
    while (now < end) {
      now = Math.min(end, now + 1000 / 60)
      k.update(now)
    }
  }
  return { c, advance }
}

afterEach(() => vi.restoreAllMocks())

describe('DAS / ARR', () => {
  it('DAS が切れるまでは最初の 1 マスだけ', () => {
    const { c, advance } = setup({ dasMs: 133, arrMs: 50 })
    advance(120)
    expect(c.moves).toBe(1)
  })

  it('DAS が切れた瞬間に、押していた時間の分をまとめて動かさない', () => {
    const { c, advance } = setup({ dasMs: 133, arrMs: 50 })
    advance(140) // DAS 直後: 最初の 1 マス + DAS の 1 マスだけ
    expect(c.moves).toBe(2)
    advance(50)
    expect(c.moves).toBe(3)
  })

  it('ARR 10ms でも DAS 直後は少しずつ動く', () => {
    const { c, advance } = setup({ dasMs: 133, arrMs: 10 })
    advance(136)
    expect(c.moves).toBeLessThanOrEqual(3)
  })
})
