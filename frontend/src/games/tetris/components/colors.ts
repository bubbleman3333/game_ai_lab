import type { CellColor } from '../engine'

/** ミノの色（ガイドライン準拠）。'G' はおじゃま */
export const PIECE_COLORS: Record<Exclude<CellColor, ''>, string> = {
  I: '#31c7ef',
  J: '#5a65ad',
  L: '#ef7921',
  O: '#f7d308',
  S: '#42b642',
  T: '#ad4d9c',
  Z: '#ef2029',
  G: '#6b6b6b',
}
