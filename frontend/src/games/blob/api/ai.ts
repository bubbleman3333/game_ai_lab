// ブロブチェイン AI の API。backend/apps/blob_ai に対応。

import { useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../../api/client'
import type { BlobGame } from '../engine/game'
import { H, W } from '../engine/rules'
import type { BlobAgentDto, BlobMoveResponse, BlobPositionDto, PairColors } from './types'

/** 盤面を下の行から各行 6 文字にする（オンライン対戦の rows と同じ形） */
export function rowsOf(game: BlobGame): string[] {
  const rows: string[] = []
  for (let y = 0; y < H; y++) {
    let s = ''
    for (let x = 0; x < W; x++) s += String(game.field.cells[y * W + x])
    rows.push(s)
  }
  return rows
}

export function positionFromGame(game: BlobGame): BlobPositionDto {
  if (!game.current) throw new Error('操作中の組がありません')
  return {
    rows: rowsOf(game),
    current: [game.current.axis, game.current.child],
    next: game.next.map((p) => [p[0], p[1]] as PairColors),
    pending: game.pending,
    carry: game.carry,
    all_clear_bonus: game.allClearBonus,
  }
}

export const fetchBlobAgents = () => apiGet<BlobAgentDto[]>('/api/blob/agents/')

export const requestBlobMove = (position: BlobPositionDto, agent?: string) =>
  apiPost<BlobMoveResponse>('/api/blob/move/', { position, agent: agent ?? '' })

/** 使える AI の一覧を読み込むフック */
export function useBlobAgents() {
  const [agents, setAgents] = useState<BlobAgentDto[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchBlobAgents().then(setAgents).catch((e: Error) => setError(e.message))
  }, [])
  return { agents, error }
}
