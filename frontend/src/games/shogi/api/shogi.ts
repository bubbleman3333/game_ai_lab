// 将棋の API。backend/apps/shogi に対応。ルールの判定・AI の探索はサーバーで行う。

import { apiGet, apiPost } from '../../../api/client'

export interface ShogiAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'random'
}

export interface AiInfo {
  move: string
  winrate?: number // AI から見た勝率
  playouts?: number
  time_ms?: number
  pv?: string[]
  candidates?: { move: string; visits: number; winrate: number | null; prior: number }[]
  trained_steps?: number
}

export interface ShogiGameDto {
  id: number
  human_color: 'black' | 'white'
  agent: string
  level: string
  sfen: string
  turn: 'black' | 'white'
  in_check: boolean
  your_turn: boolean
  legal_moves: string[]
  can_declare: boolean
  moves: string[]
  kif: string[]
  last_move: string | null
  result: 'human_win' | 'ai_win' | 'draw' | null
  reason: string | null
  ai: AiInfo | null
}

export interface SummaryRow {
  agent: string
  level: string
  games: number
  human_wins: number
  human_losses: number
  draws: number
}

export const fetchAgents = () => apiGet<ShogiAgentDto[]>('/api/shogi/agents/')
export const fetchLevels = () => apiGet<{ id: string; label: string }[]>('/api/shogi/levels/')
export const startGame = (body: { human_color: 'black' | 'white'; agent: string; level: string }) =>
  apiPost<ShogiGameDto>('/api/shogi/games/', body)
export const playMove = (id: number, move: string) => apiPost<ShogiGameDto>(`/api/shogi/games/${id}/move/`, { move })
export const gameAction = (id: number, action: 'undo' | 'resign' | 'declare') =>
  apiPost<ShogiGameDto>(`/api/shogi/games/${id}/${action}/`)
export const fetchSummary = () => apiGet<SummaryRow[]>('/api/shogi/games/summary/')
