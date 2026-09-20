// ポーカーの API。backend/apps/poker に対応。
//
// ルールの進行と AI の手はサーバーで行う。ポーカーは相手の手札が見えないゲームなので、
// ほかのゲームのように「盤面をブラウザに渡して手だけ聞く」作りにはできない
// （渡した瞬間に AI の手札が見えてしまう）。ここで受け取るのは
// **自分に見せていいもの** だけで、AI の手札はショーダウンのときだけ入っている。

import { apiGet, apiPost } from '../../../api/client'

export interface PokerAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'heuristic'
  /** neural = ニューラルネット（Deep CFR）、table = 表形式の CFR、heuristic = ルールベース */
  family: 'neural' | 'table' | 'heuristic'
  /** 画面に出す一言（学習量など） */
  detail: string
}

/** ワンタッチで押せるレイズ額 */
export interface RaisePreset {
  label: string
  to: number
}

export interface PokerActionsDto {
  can_fold: boolean
  can_check: boolean
  can_call: boolean
  call_amount: number
  can_raise: boolean
  min_raise_to: number
  max_raise_to: number
  presets: RaisePreset[]
}

export interface PokerResultDto {
  payoff: [number, number]
  /** 勝った席（-1 = 引き分け） */
  winner: number
  /** 降りた席（-1 = 誰も降りていない＝ショーダウン） */
  folded: number
  showdown: boolean
  human_hand: string | null
  ai_hand: string | null
  /** 飛んだ席（-1 = まだ続けられる） */
  busted: number
}

export interface PokerLogLine {
  player: number
  street: number
  street_name: string
  who: string
  text: string
}

export interface PokerTableDto {
  table_id: string
  agent: string
  hand_no: number
  /** ボタン（スモールブラインド）の席 */
  button: number
  you: number
  ai: number
  blinds: [number, number]
  street: number
  street_name: string
  /** 表に出ているボード（"As" の形） */
  board: string[]
  your_hole: string[]
  /** ショーダウンまで null */
  ai_hole: string[] | null
  pot: number
  committed: [number, number]
  street_bet: [number, number]
  /** この局の残りスタック */
  hand_stacks: [number, number]
  /** 持ち越しのスタック */
  table_stacks: [number, number]
  start_stack: number
  to_act: number | null
  to_call: number
  finished: boolean
  log: PokerLogLine[]
  /** 席ごとの「このストリートで最後にした行動」。画面の吹き出しに出す */
  last_actions: (string | null)[]
  result: PokerResultDto | null
  actions: PokerActionsDto
}

export type ActionKind = 'fold' | 'check' | 'call' | 'raise'

export interface PokerAgentStat {
  agent: string
  hands: number
  human_chips: number
  /** AI から見た 1 局あたりの収支（ビッグブラインドの 1/1000 単位） */
  ai_mbb_per_hand: number
  avg_pot: number
}

export interface PokerHandRow {
  hand_no: number
  agent: string
  stack_bb: number
  human_payoff: number
  pot: number
  showdown: boolean
  board: string
  human_hole: string
  ai_hole: string
  created_at: string
}

export const fetchAgents = () => apiGet<PokerAgentDto[]>('/api/poker/agents/')

export const createTable = (agent: string, stack: number) =>
  apiPost<PokerTableDto>('/api/poker/tables/', { agent, stack })

export const fetchTable = (id: string) => apiGet<PokerTableDto>(`/api/poker/tables/${id}/`)

export const sendAction = (id: string, kind: ActionKind, to = 0) =>
  apiPost<PokerTableDto>(`/api/poker/tables/${id}/action/`, { kind, to })

export const nextHand = (id: string) => apiPost<PokerTableDto>(`/api/poker/tables/${id}/next/`)

export const fetchPokerStats = () =>
  apiGet<{ agents: PokerAgentStat[]; recent: PokerHandRow[] }>('/api/poker/stats/')
