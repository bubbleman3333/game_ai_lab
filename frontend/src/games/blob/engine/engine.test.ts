// ブロブチェインのルールのテスト（連鎖・得点・おじゃま・回転）。

import { describe, expect, it } from 'vitest'
import { BlobGame } from './game'
import { Field, GARBAGE, W, chainScore } from './rules'

/** 下の行から文字列で盤面を作る（'.' 空き、'1'〜'4' 色、'G' おじゃま） */
function fieldOf(rowsBottomUp: string[]): Field {
  const f = new Field()
  rowsBottomUp.forEach((row, y) => [...row].forEach((ch, x) => f.set(x, y, ch === '.' ? 0 : ch === 'G' ? GARBAGE : Number(ch))))
  return f
}

function gameWith(rows: string[]): BlobGame {
  const g = new BlobGame(1)
  g.field = fieldOf(rows)
  return g
}

describe('blob rules', () => {
  it('4 つつながると消え、得点は 10 × 個数 × 1', () => {
    const g = gameWith(['1111..'])
    const step = g.popStep()!
    expect(step.chain).toBe(1)
    expect(step.cells.length).toBe(4)
    expect(step.score).toBe(40)
    expect(g.field.isEmpty()).toBe(true)
  })

  it('3 つでは消えない', () => {
    expect(gameWith(['111...']).popStep()).toBeNull()
  })

  it('2 連鎖（連鎖ボーナス 8 + 連結ボーナス）', () => {
    // 1（赤）4 つが消えると、上の 2（青）が落ちて、青 5 つがつながる
    const g = gameWith([
      '1112..',
      '212...',
      '22....',
    ])
    const s1 = g.popStep()!
    expect(s1.chain).toBe(1)
    g.settle()
    const s2 = g.popStep()!
    expect(s2.chain).toBe(2)
    expect(s2.score).toBe(10 * 5 * (8 + 2)) // 青 5 つ × (連鎖ボーナス 8 + 5 個つながりのボーナス 2)
  })

  it('消えた粒の隣のおじゃまも消える', () => {
    const g = gameWith(['1111G.'])
    const step = g.popStep()!
    expect(step.cells.length).toBe(5)
    expect(g.field.get(4, 0)).toBe(0)
  })

  it('得点 70 点ごとにおじゃま 1 つ。余りは持ち越し、予告を先に相殺する', () => {
    const g = gameWith(['111111', '111...'])  // 同じ色 9 つ: 10 × 9 × 連結ボーナス 6 = 540 点 → 7 個（余り 50）
    g.receiveGarbage(3)
    const s = g.popStep()!
    expect(s.score).toBe(540)
    expect(s.attack).toBe(7)
    expect(s.cancelled).toBe(3)
    expect(s.sent).toBe(4)
    expect(g.pending).toBe(0)
  })

  it('連鎖の得点の計算（色数ボーナス）', () => {
    // 2 色が同時に消える: 色数ボーナス 3
    expect(chainScore([[0, 1, 2, 3], [10, 11, 12, 13]], (g) => (g[0] < 10 ? 1 : 2), 1)).toBe(10 * 8 * 3)
  })

  it('おじゃまは列ごとに均等に降り、端数は別々の列に', () => {
    const g = gameWith([])
    g.receiveGarbage(8)
    g.dropGarbage()
    const heights = [...Array(W).keys()].map((x) => [...Array(13).keys()].filter((y) => g.field.get(x, y) === GARBAGE).length)
    expect(heights.reduce((a, b) => a + b, 0)).toBe(8)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
  })

  it('壁際で回すと押し出される', () => {
    const g = new BlobGame(1)
    for (let i = 0; i < 5; i++) g.move(1) // 右端へ
    expect(g.current!.x).toBe(5)
    expect(g.rotate(1)).toBe(true) // 子が右に行けないので軸が左へずれる
    expect(g.current!.x).toBe(4)
    expect(g.current!.rot).toBe(1)
  })

  it('出現位置がふさがると負け', () => {
    const g = gameWith([])
    for (let y = 0; y < 12; y++) g.field.set(2, y, 1 + (y % 2) * 1 + (y % 3 === 0 ? 2 : 0))
    g.current = null
    expect(g.spawn()).toBe(false)
    expect(g.over).toBe(true)
  })
})
