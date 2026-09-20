// テトリス AI の API。backend/apps/tetris_ai に対応。

import { apiGet, apiPost } from '../../../api/client'
import type { Game } from '../engine'
import type { AgentDto, MoveResponse, OpponentDto, PositionDto } from './types'

export function positionFromGame(game: Game, opponent?: OpponentDto | null): PositionDto {
  if (!game.current) throw new Error('操作中のミノがありません')
  return {
    rows: game.board.rows.slice(0, 24),
    current: game.current.type,
    hold: game.hold,
    can_hold: game.canHold,
    next: game.nextPieces,
    combo: game.combo,
    b2b: game.b2b,
    pending: game.pending.map((p) => [p[0], p[1]]),
    opponent: opponent ?? null,
  }
}

/** 相手の盤面。相手を見る AI（feature_version 2 以降）だけが使う */
export function opponentFromGame(game: Game): OpponentDto {
  return {
    rows: game.board.rows.slice(0, 24),
    pending: game.pending.map((p) => [p[0], p[1]]),
    combo: game.combo,
    b2b: game.b2b,
  }
}

export const fetchAgents = () => apiGet<AgentDto[]>('/api/tetris/agents/')

export const requestMove = (position: PositionDto, agent?: string) =>
  apiPost<MoveResponse>('/api/tetris/move/', { position, agent: agent ?? '' })
