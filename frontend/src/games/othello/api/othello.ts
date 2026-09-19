// オセロの API。backend/apps/othello に対応。

import { ApiError, apiGet, apiPost, apiUrl } from '../../../api/client'
import type { NTupleSpec } from '../engine/evaluators'

export interface OthelloAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'positional'
}

export interface OthelloGameDto {
  id: number
  moves: string
  human_color: 'black' | 'white'
  agent: string
  level: string
  black_discs: number
  white_discs: number
  human_result: number
  created_at: string
}

export interface SummaryRow {
  agent: string
  level: string
  games: number
  human_wins: number
  human_losses: number
  draws: number
}

export const fetchAgents = () => apiGet<OthelloAgentDto[]>('/api/othello/agents/')
export const fetchSpec = () => apiGet<NTupleSpec>('/api/othello/spec/')

/** 学習した重み（Float32 のバイナリ） */
export async function fetchWeights(agentId: string): Promise<Float32Array> {
  const res = await fetch(apiUrl(`/api/othello/agents/${encodeURIComponent(agentId)}/weights/`))
  if (!res.ok) throw new ApiError(res.status, 'weights', `重みを読み込めません（HTTP ${res.status}）`)
  return new Float32Array(await res.arrayBuffer())
}

export const saveGame = (body: { moves: string; human_color: 'black' | 'white'; agent: string; level: string }) =>
  apiPost<OthelloGameDto>('/api/othello/games/', body)
export const fetchSummary = () => apiGet<SummaryRow[]>('/api/othello/games/summary/')
