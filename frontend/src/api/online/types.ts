// オンライン対戦の部屋の型（テトリス・ブロブチェイン共通）。backend/apps/tetris_online/serializers.py と対応。

export interface RoomPlayerDto {
  slot: number
  name: string
  ready: boolean
  alive: boolean
  wins: number
}

export interface RoomDto {
  code: string
  status: 'waiting' | 'playing'
  round: number
  players: RoomPlayerDto[]
  created_at?: string
}
