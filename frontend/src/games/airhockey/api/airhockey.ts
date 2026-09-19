// エアホッケーの API。backend/apps/airhockey に対応。

import { apiGet, apiPost } from '../../../api/client'
import type { PolicyJson } from '../engine/policy'

export interface AirHockeyAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'heuristic'
}

export interface SummaryRow {
  agent: string
  level: string
  games: number
  human_wins: number
  human_losses: number
  human_points: number
  ai_points: number
}

export const fetchAgents = () => apiGet<AirHockeyAgentDto[]>('/api/airhockey/agents/')
export const fetchPolicy = (id: string) => apiGet<PolicyJson>(`/api/airhockey/agents/${encodeURIComponent(id)}/policy/`)
export const saveMatch = (body: { agent: string; level: string; human_score: number; ai_score: number; duration_sec: number }) =>
  apiPost<{ ok: boolean }>('/api/airhockey/matches/', body)
export const fetchSummary = () => apiGet<SummaryRow[]>('/api/airhockey/matches/summary/')
