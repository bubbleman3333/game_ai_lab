// ブロブチェイン API の入出力の型。backend/apps/blob_ai/serializers.py と対応させる。

/** 組ぷよ [軸の色, 子の色]（どちらも 1〜4） */
export type PairColors = [number, number]

/** AI に渡す局面。rows は下の行から各行 6 文字（'0' 空き / '1'〜'4' 色 / '5' おじゃま） */
export interface BlobPositionDto {
  rows: string[]
  current: PairColors
  next: PairColors[]
  pending: number
  /** 70 点に満たずに持ち越している得点 */
  carry: number
  /** 全消し直後（次の消去にボーナス） */
  all_clear_bonus: boolean
}

export interface BlobMoveResponse {
  agent: string
  /** 何エピソード目まで学習した重みか。学習中は best が更新されると自動で新しくなる */
  agent_episode: number | null
  placement: { x: number; rot: number }
  /** 出たばかりの組に対する操作列（最後は "HD"） */
  path: BlobAction[]
  expected: { chain: number; score: number; sent: number; cancelled: number; all_clear: boolean; dead: boolean }
}

export type BlobAction = 'L' | 'R' | 'CW' | 'CCW' | 'HD'

export interface BlobAgentDto {
  id: string
  label: string
  run: string | null
  kind: 'best' | 'latest' | 'heuristic'
}
