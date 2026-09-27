// AI の手を 1 つずつ見せるための途中の局面が、読み上げからそれらしく作れること
import { describe, expect, it } from 'vitest'
import type { PokerLogLine, PokerTableDto } from './api/poker'
import { dealBase, optimisticLine, stagedView } from './staging'

const line = (player: number, text: string, street = 1): PokerLogLine =>
  ({ player, street, street_name: ['プリフロップ', 'フロップ', 'ターン', 'リバー'][street], who: '', text }) as PokerLogLine

function base(): PokerTableDto {
  return {
    table_id: 't', agent: 'a', hand_no: 3, button: 0, you: 0, ai: 1, blinds: [1, 2],
    street: 1, street_name: 'フロップ', board: ['Ts', '3c', 'Kd'], your_hole: ['6s', 'Js'], ai_hole: null,
    pot: 4, committed: [2, 2], street_bet: [0, 0], hand_stacks: [198, 198], table_stacks: [200, 200],
    start_stack: 200, to_act: 0, to_call: 0, finished: false,
    log: [line(0, 'あなた: コール 1', 0), line(1, 'AI: チェック', 0), line(1, 'AI: チェック')],
    last_actions: [null, null], result: null,
    actions: { can_fold: false, can_check: true, can_call: false, call_amount: 0, can_raise: true,
      min_raise_to: 2, max_raise_to: 198, presets: [] },
  }
}

describe('stagedView', () => {
  it('自分のベットだけを反映した局面が作れる', () => {
    const b = base()
    const mine = optimisticLine(b, 'raise', 4)
    expect(mine.text).toBe('あなた: ベット 4')
    const view = stagedView(b, { ...b, log: [...b.log, mine] }, b.log.length + 1, false)
    expect(view.pot).toBe(8)
    expect(view.street_bet).toEqual([4, 0])
    expect(view.committed).toEqual([6, 2])
    expect(view.to_act).toBe(1)
    expect(view.log).toHaveLength(4)
  })

  it('AI のレイズを 1 つ足すとポットが増え、全部見せたらサーバーの局面になる', () => {
    const b = base()
    const final: PokerTableDto = {
      ...b, pot: 18, street_bet: [4, 10], committed: [6, 12], to_act: 0, to_call: 6,
      log: [...b.log, line(0, 'あなた: ベット 4'), line(1, 'AI: レイズ to 10')],
    }
    const mid = stagedView(b, final, b.log.length + 2)
    expect(mid).toBe(final)
    const before = stagedView(b, final, b.log.length + 1)
    expect(before.pot).toBe(8)
    expect(before.finished).toBe(false)
  })

  it('AI がコールして次のストリートに進んだら、ボードをそこまで出す', () => {
    const b = base()
    const final: PokerTableDto = {
      ...b, street: 2, street_name: 'ターン', board: ['Ts', '3c', 'Kd', '5h'], pot: 12, street_bet: [0, 0],
      committed: [6, 6], to_act: 1,
      log: [...b.log, line(0, 'あなた: ベット 4'), line(1, 'AI: コール 4'), line(1, 'AI: チェック', 2)],
    }
    const afterCall = stagedView(b, final, b.log.length + 2)
    expect(afterCall.pot).toBe(12)
    expect(afterCall.board).toHaveLength(3)
    expect(afterCall.street).toBe(1)
    const afterCheck = stagedView(b, final, b.log.length + 3)
    expect(afterCheck).toBe(final)
  })

  it('配った直後の局面はブラインドだけ', () => {
    const next: PokerTableDto = { ...base(), hand_no: 4, button: 1, street: 0, street_name: 'プリフロップ',
      board: [], pot: 8, street_bet: [2, 6], committed: [2, 6], log: [line(1, 'AI: レイズ to 6', 0)] }
    const d = dealBase(next)
    expect(d.pot).toBe(3)
    expect(d.street_bet).toEqual([2, 1])
    expect(d.log).toEqual([])
    expect(stagedView(d, next, 1)).toBe(next)
  })

  it('コールとオールインの読み上げ', () => {
    const b = base()
    expect(optimisticLine({ ...b, actions: { ...b.actions, call_amount: 6 } }, 'call', 0).text).toBe('あなた: コール 6')
    expect(optimisticLine(b, 'raise', 198).text).toBe('あなた: オールイン（198）')
    expect(optimisticLine({ ...b, street_bet: [0, 10] }, 'raise', 24).text).toBe('あなた: レイズ to 24')
  })
})
