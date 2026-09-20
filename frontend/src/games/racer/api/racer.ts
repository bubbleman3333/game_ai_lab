// レースの API。backend/apps/racer に対応。

import { apiGet, apiPost } from '../../../api/client'
import type { PolicyJson } from '../engine/policy'

export interface RacerAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'heuristic'
}

export interface LapRow {
  course: string
  car: string
  runs: number
  best_lap: number | null
  best_total: number | null
  wins: number
  losses: number
}

export interface SaveResultBody {
  course: string
  car: string
  agent: string
  laps: number
  total_sec: number
  best_lap_sec: number
  tricks: number
  falls: number
  /** AI と走ったときの順位（1 = 勝ち）。タイムアタックなら null */
  place: number | null
  racers: number
}

export const fetchAgents = () => apiGet<RacerAgentDto[]>('/api/racer/agents/')
export const fetchPolicy = (id: string) =>
  apiGet<PolicyJson>(`/api/racer/agents/${encodeURIComponent(id)}/policy/`)
export const saveResult = (body: SaveResultBody) => apiPost<{ ok: boolean }>('/api/racer/results/', body)
export const fetchSummary = () => apiGet<LapRow[]>('/api/racer/results/summary/')
