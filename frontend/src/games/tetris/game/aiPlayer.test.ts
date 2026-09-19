// AI の操作役が、サーバーの一時的なエラー（再起動中の 502 など）で止まらず、聞き直して続けるかを確かめる。

import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../api/client'
import { Game, GameController } from '../engine'

const requestMove = vi.fn()
vi.mock('../api/ai', () => ({
  positionFromGame: () => ({}),
  requestMove: (...args: unknown[]) => requestMove(...args),
}))

const { AiPlayer } = await import('./aiPlayer')

describe('AiPlayer', () => {
  it('retries after a transient server error', async () => {
    requestMove
      .mockRejectedValueOnce(new ApiError(502, 'error', 'HTTP 502'))
      .mockResolvedValue({ agent: 'x', agent_episode: 1, path: ['HD'] })
    const controller = new GameController(new Game(1), { gravityMs: 0 })
    const ai = new AiPlayer(controller, { actionDelayMs: 0, pieceDelayMs: 0 })
    const errors: (string | null)[] = []
    ai.onError = (m) => errors.push(m)
    ai.start()

    let now = performance.now()
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        now += 50
        ai.update(now)
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    await run(3000)

    expect(errors[0]).toContain('再接続')
    expect(errors).toContain(null) // 復旧したらエラー表示を消す
    expect(controller.game.stats.pieces).toBeGreaterThan(0) // 止まらずに置き続けている
  })

  it('falls back to the default agent when the chosen one is gone (404)', async () => {
    requestMove.mockReset()
    requestMove
      .mockRejectedValueOnce(new ApiError(404, 'not_found', 'AI は見つかりません'))
      .mockResolvedValue({ agent: 'default', agent_episode: 1, path: ['HD'] })
    const controller = new GameController(new Game(2), { gravityMs: 0 })
    const ai = new AiPlayer(controller, { agent: 'gone:best', actionDelayMs: 0, pieceDelayMs: 0 })
    const errors: (string | null)[] = []
    ai.onError = (m) => errors.push(m)
    ai.start()
    let now = performance.now()
    for (let t = 0; t < 3000; t += 50) {
      now += 50
      ai.update(now)
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(errors[0]).toContain('既定の AI に切り替え')
    expect(requestMove.mock.calls.at(-1)?.[1]).toBeUndefined() // 2 回目以降は既定の AI に聞いている
    expect(controller.game.stats.pieces).toBeGreaterThan(0)
  })

  it('places pieces at the chosen PPS without drifting', async () => {
    requestMove.mockReset()
    requestMove.mockResolvedValue({ agent: 'x', agent_episode: 1, path: ['L', 'HD'] })
    const controller = new GameController(new Game(3), { gravityMs: 0 })
    const ai = new AiPlayer(controller, { actionDelayMs: 30, pieceDelayMs: 500 }) // 2 PPS
    ai.start()
    let now = performance.now()
    for (let t = 0; t < 4100; t += 1000 / 60) { // 60fps で 4.1 秒
      now += 1000 / 60
      ai.update(now)
      await new Promise((r) => setTimeout(r, 0))
    }
    // 2 PPS なら 4.1 秒で 8 手。1 フレームの遅れが毎手たまると 7 手に減る
    expect(controller.game.stats.pieces).toBe(8)
  })
})
