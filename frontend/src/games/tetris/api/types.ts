// テトリス API の入出力の型。backend/apps/tetris_ai・tetris_online の serializers.py と対応させる。

import type { Action, PieceType, Spin } from '../engine'

// --- AI (/api/tetris/) -------------------------------------------------------------

/** AI に渡す局面。rows は下の行から 10bit 整数 */
export interface PositionDto {
  rows: number[]
  current: PieceType
  hold: PieceType | null
  can_hold: boolean
  next: PieceType[]
  combo: number
  b2b: boolean
  pending: [number, number][]
}

export interface MoveResponse {
  agent: string
  /** 何エピソード目まで学習した重みか。学習中は best が更新されると自動で新しくなる */
  agent_episode: number | null
  use_hold: boolean
  placement: { piece: PieceType; rot: number; x: number; y: number; spin: Spin; path: Action[] }
  /** HOLD を含む、HD までの操作列 */
  path: Action[]
  expected: { lines: number; attack: number; dead: boolean }
}

export interface AgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'heuristic'
}

export type { RoomDto, RoomPlayerDto } from '../../../api/online/types'
