// 学習結果の API（ゲーム共通）。backend/apps/training に対応。

import { apiGet, apiPost } from './client'

export type GameName = 'tetris' | 'othello' | 'airhockey' | 'shogi'

export interface TrainingRunDto {
  game: GameName
  name: string
  config: Record<string, unknown>
  status: {
    state?: 'running' | 'finished' | 'stopped'
    episode?: number
    episodes?: number
    elapsed_sec?: number
    updated_at?: string
  }
  synced_at: string
}

/** metrics.jsonl をまとめたもの。avg / max の中身（項目名）はゲームごとに違う */
export interface MetricBucket {
  episode: number
  step: number
  episodes: number
  avg: Record<string, number>
  max: Record<string, number>
}

export interface EvaluationDto<R = Record<string, unknown>> {
  episode: number
  step: number
  checkpoint: string
  score: number
  is_best: boolean
  /** 中身はゲームごとに違う（テトリス: モード別の成績、オセロ: 相手別の勝率） */
  results: R
  evaluated_at: string | null
}

export interface SyncResultDto {
  game: GameName
  run: string
  new_metrics: number
  new_evaluations: number
}

const runPath = (game: GameName, name: string) =>
  `/api/training/runs/${encodeURIComponent(game)}/${encodeURIComponent(name)}`

export const fetchRuns = (game: GameName) => apiGet<TrainingRunDto[]>(`/api/training/runs/?game=${game}`)
export const fetchRunMetrics = (game: GameName, name: string, bucket = 50) =>
  apiGet<{ bucket: number; points: MetricBucket[] }>(`${runPath(game, name)}/metrics/?bucket=${bucket}`)
export const fetchEvaluations = <R>(game: GameName, name: string) =>
  apiGet<EvaluationDto<R>[]>(`${runPath(game, name)}/evaluations/`)
export const syncRuns = () => apiPost<SyncResultDto[]>('/api/training/sync/')
