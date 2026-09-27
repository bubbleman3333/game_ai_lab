// AI の手を「少し間を置いて 1 つずつ」見せるための、途中の局面の作り方。
//
// サーバーは 1 回の返事で「自分の手 → AI の手（1 つか 2 つ）→ 進んだ局面」を全部返してくる。
// そのまま出すと、自分が打った瞬間に AI の手まで一気に出て何が起きたか分からない。そこで
//
// 1. 打った瞬間に、まず自分の手だけを局面に反映して見せる（`optimisticLine` + `stagedView`）
// 2. 返事が来ても、少し間を置いてから AI の手を 1 つずつ足していく（`stagedView` の `shown` を増やす）
// 3. 全部見せ終わったら、サーバーの局面そのものに切り替える
//
// 途中の局面はサーバーからは来ないので、読み上げの文（「コール 4」「レイズ to 10」）から
// ポットと賭け額を数えて作る。細かい額の計算は最後にサーバーの値で上書きされるので、
// 数秒の間だけそれらしければよい。

import type { ActionKind, PokerLogLine, PokerTableDto } from './api/poker'

const BOARD_COUNT = [0, 3, 4, 5]
const STREET_NAMES = ['プリフロップ', 'フロップ', 'ターン', 'リバー']

/** 自分が打った手の読み上げ（サーバーが作るものと同じ文）。 */
export function optimisticLine(table: PokerTableDto, kind: ActionKind, to: number): PokerLogLine {
  const you = table.you
  let text: string
  if (kind === 'fold') text = 'フォールド'
  else if (kind === 'check') text = 'チェック'
  else if (kind === 'call') text = `コール ${table.actions.call_amount}`
  else if (to >= table.actions.max_raise_to) text = `オールイン（${to}）`
  else if (table.street_bet[table.ai] === 0) text = `ベット ${to}`
  else text = `レイズ to ${to}`
  return { player: you, street: table.street, street_name: table.street_name, who: 'あなた', text: `あなた: ${text}` }
}

/** 新しい局が配られた直後（AI がまだ何も打っていない）の局面。 */
export function dealBase(next: PokerTableDto): PokerTableDto {
  const sb = next.button
  const blinds: [number, number] = sb === 0 ? [1, 2] : [2, 1]
  return {
    ...next,
    log: [],
    street: 0,
    street_name: STREET_NAMES[0],
    board: [],
    ai_hole: null,
    pot: 3,
    street_bet: blinds,
    committed: blinds,
    finished: false,
    result: null,
    to_act: next.ai,
    to_call: 0,
  }
}

/**
 * `base`（打つ前の局面）から `final.log` の先頭 `shown` 行までを反映した局面。
 * 全部反映し終わったら `final` そのものを返す（`settled` が false のときは、`final` が
 * 「自分の手を足しただけの仮の局面」なので、最後まで読み上げから作る）。
 */
export function stagedView(base: PokerTableDto, final: PokerTableDto, shown: number, settled = true): PokerTableDto {
  if (settled && shown >= final.log.length) return final
  let pot = base.pot
  const streetBet: [number, number] = [base.street_bet[0], base.street_bet[1]]
  const committed: [number, number] = [base.committed[0], base.committed[1]]
  let street = base.street
  const lines = final.log.slice(0, shown)
  for (const line of lines.slice(base.log.length)) {
    if (line.street > street) {
      street = line.street
      streetBet[0] = streetBet[1] = 0
    }
    const p = line.player
    const body = line.text.split(': ', 2)[1] ?? ''
    let m: RegExpExecArray | null
    if ((m = /^コール (\d+)/.exec(body))) {
      const add = Number(m[1])
      pot += add
      streetBet[p] += add
      committed[p] += add
    } else if ((m = /^(?:ベット |レイズ to |オールイン（)(\d+)/.exec(body))) {
      const to = Number(m[1])
      const add = Math.max(0, to - streetBet[p])
      pot += add
      committed[p] += add
      streetBet[p] = to
    }
  }
  return {
    ...final,
    log: lines,
    street,
    street_name: STREET_NAMES[street],
    board: final.board.slice(0, BOARD_COUNT[street]),
    ai_hole: null,
    pot,
    street_bet: streetBet,
    committed,
    table_stacks: base.table_stacks,
    finished: false,
    result: null,
    to_act: final.ai,
    to_call: 0,
    actions: {
      can_fold: false, can_check: false, can_call: false, call_amount: 0,
      can_raise: false, min_raise_to: 0, max_raise_to: 0, presets: [],
    },
  }
}
