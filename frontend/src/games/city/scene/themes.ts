// 街ごとの見た目（空気の色・霧・天気・雪）。sim/maps.ts の theme と同じ名前で選ばれる。

import type { ThemeId } from '../sim/maps'

export interface CityTheme {
  weather: 'clear' | 'rain' | 'snow'
  /** 路面の濡れ具合（0〜1）。濡れるとつやが出て、空や明かりが映る */
  wet: number
  /** 地面・屋根を雪で白くする */
  snow: boolean
  /** 霧の濃さ（FogExp2 の density）と、昼の霧の色 */
  fog: number
  haze: number
  /** 空（Sky シェーダー）の濁り・青さ・太陽のまわりのにじみ */
  turbidity: number
  rayleigh: number
  mie: number
  /** HUD の差し色 */
  accent: string
}

export const THEMES: Record<ThemeId, CityTheme> = {
  bay: { weather: 'clear', wet: 0, snow: false, fog: 0.0016, haze: 0xa9c0d2, turbidity: 5, rayleigh: 1.3, mie: 0.005, accent: '#5fc8ff' },
  metro: { weather: 'rain', wet: 1, snow: false, fog: 0.003, haze: 0x7f8894, turbidity: 12, rayleigh: 0.8, mie: 0.012, accent: '#c77dff' },
  sunset: { weather: 'clear', wet: 0, snow: false, fog: 0.0018, haze: 0xe0aa80, turbidity: 8, rayleigh: 3, mie: 0.01, accent: '#ffab5c' },
  snow: { weather: 'snow', wet: 0.3, snow: true, fog: 0.0042, haze: 0xc5ced8, turbidity: 12, rayleigh: 1, mie: 0.01, accent: '#9fe3ff' },
}
