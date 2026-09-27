// 行動バッジの元になる「直近の行動」の切り出しと種類の判定
import { describe, expect, it } from 'vitest'
import type { PokerLogLine } from '../api/poker'
import { actionKind, recentActions } from './PokerFelt'

const line = (player: number, text: string, street = 0): PokerLogLine =>
  ({ player, street, street_name: ['プリフロップ', 'フロップ', 'ターン', 'リバー'][street], who: '', text }) as PokerLogLine

describe('recentActions', () => {
  it('相手の直前の行動より後の自分の行動を全部返す（コール → 次のストリートでチェック）', () => {
    const log = [line(0, 'あなた: レイズ to 8'), line(1, 'AI: コール 6'), line(1, 'AI: チェック', 1)]
    expect(recentActions(log, 1).map((x) => x.line.text)).toEqual(['AI: コール 6', 'AI: チェック'])
    expect(recentActions(log, 0).map((x) => x.line.text)).toEqual(['あなた: レイズ to 8'])
  })
  it('自分の行動が相手より前しか無ければ最後の 1 つを返す', () => {
    const log = [line(1, 'AI: レイズ to 6'), line(0, 'あなた: コール 4'), line(0, 'あなた: チェック', 1)]
    expect(recentActions(log, 1).map((x) => x.line.text)).toEqual(['AI: レイズ to 6'])
  })
  it('何も無ければ空', () => {
    expect(recentActions([], 1)).toEqual([])
  })
})

describe('actionKind', () => {
  it('文から種類を判定する', () => {
    expect(actionKind('AI: フォールド')).toBe('fold')
    expect(actionKind('AI: チェック')).toBe('check')
    expect(actionKind('AI: コール 4')).toBe('call')
    expect(actionKind('AI: レイズ to 12')).toBe('raise')
    expect(actionKind('AI: オールイン（198）')).toBe('allin')
  })
})
