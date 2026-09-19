import { describe, expect, it } from 'vitest'
import { BlobGame } from '../engine/game'
import { H, W } from '../engine/rules'
import { fieldToText } from './onlineMatch'

describe('fieldToText', () => {
  it('盤と落下中の組を下の行から 6 文字ずつにする', () => {
    const g = new BlobGame(1)
    g.field.set(0, 0, 5)
    g.field.set(5, 0, 2)
    const rows = fieldToText(g)
    expect(rows).toHaveLength(H)
    expect(rows.every((r) => r.length === W)).toBe(true)
    expect(rows[0]).toMatch(/^5....2$/)
    const p = g.current!
    expect(rows[p.y][p.x]).toBe(String(p.axis))
  })
})
