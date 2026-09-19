// 対戦部屋の REST API（テトリス・ブロブチェイン共通）。backend/apps/tetris_online/views.py に対応。

import { apiGet, apiPost } from '../client'
import type { OnlineGame } from './protocol'
import type { RoomDto } from './types'

// game: どのゲームの部屋か（/api/<game>/rooms/）
export const createRoom = (game: OnlineGame = 'tetris') => apiPost<RoomDto>(`/api/${game}/rooms/`)
export const listOpenRooms = (game: OnlineGame = 'tetris') => apiGet<RoomDto[]>(`/api/${game}/rooms/`)
export const getRoom = (code: string, game: OnlineGame = 'tetris') =>
  apiGet<RoomDto>(`/api/${game}/rooms/${encodeURIComponent(code)}/`)
