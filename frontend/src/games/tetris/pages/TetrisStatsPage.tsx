// テトリス AI の強さ。表示する項目だけを決め、画面は共通の TrainingStats に任せる。

import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'

/** rl/tetris/evaluate.py の結果。ひとり遊び（モード別）と、AI 同士の対戦（相手別）が入る */
interface ModeResult {
  avg_lines: number
  avg_attack: number
  attack_per_piece: number
  tspins_per_100: number
  tetrises_per_100: number
  survival_rate: number
}
/** rl/tetris/match.py の結果。引き分けは 0.5 勝として数えた勝率 */
interface VersusResult {
  games: number
  win_rate: number
  draw_rate: number
  avg_attack: number
  avg_attack_taken: number
}
type Results = Record<'solo' | 'pressure', ModeResult | undefined> &
  Record<'vs_heuristic' | 'vs_best', VersusResult | undefined>

const solo = (r: Results) => r.solo ?? ({} as ModeResult)
const pressure = (r: Results) => r.pressure ?? ({} as ModeResult)
const vs = (key: 'vs_heuristic' | 'vs_best') => (r: Results) => r[key]?.win_rate ?? 0

const CONFIG: StatsConfig<Results> = {
  game: 'tetris',
  title: 'テトリス AI の強さ',
  baselineRun: 'heuristic-baseline',
  baselineLabel: 'ヒューリスティック',
  evalNote: 'AI 同士を戦わせた勝率と、決まった seed でひとりで遊ばせた平均（最大 300 手）',
  evalCharts: [
    { title: '勝率 vs これまでの best', value: (e) => vs('vs_best')(e.results), format: fmt.pct },
    { title: '勝率 vs ヒューリスティック', value: (e) => vs('vs_heuristic')(e.results), format: fmt.pct },
    { title: 'ひとりで消したライン数', value: (e) => solo(e.results).avg_lines ?? 0, format: fmt.n1 },
    { title: 'おじゃまありの火力', value: (e) => pressure(e.results).avg_attack ?? 0, format: fmt.n1 },
    { title: 'おじゃまありの生存率', value: (e) => pressure(e.results).survival_rate ?? 0, format: fmt.pct },
    { title: '1 手あたりの火力', value: (e) => pressure(e.results).attack_per_piece ?? 0, format: fmt.n2 },
  ],
  metricCharts: [
    {
      title: '相手から受けた火力（1 手あたり）', key: 'garbage_rate', format: fmt.n2,
      note: '自己対戦に入ると、相手が強くなるほど上がっていく（それまではランダムに降らせた量）',
    },
    { title: '消したライン数', key: 'lines', format: fmt.n1 },
    { title: '火力', key: 'attack', format: fmt.n1 },
    { title: '置いたミノ数', key: 'pieces', format: fmt.n1 },
    { title: 'T-Spin で消した回数', key: 'tspin_clears', format: fmt.n2 },
    { title: 'loss（予測と目標のずれ）', key: 'loss', format: fmt.n3, note: '下がって落ち着けば学習が安定しています' },
    { title: 'ε（ランダムに打つ確率）', key: 'epsilon', format: fmt.pct },
  ],
  table: [
    { label: 'vs best', value: (e) => fmt.pct(vs('vs_best')(e.results)) },
    { label: 'vs ヒューリスティック', value: (e) => fmt.pct(vs('vs_heuristic')(e.results)) },
    { label: 'ひとり: ライン', value: (e) => fmt.n1(solo(e.results).avg_lines ?? 0) },
    { label: 'ひとり: テトリス/100手', value: (e) => fmt.n1(solo(e.results).tetrises_per_100 ?? 0) },
    { label: 'おじゃま: 火力', value: (e) => fmt.n1(pressure(e.results).avg_attack ?? 0) },
    { label: '火力/手', value: (e) => fmt.n2(pressure(e.results).attack_per_piece ?? 0) },
    { label: '生存率', value: (e) => fmt.pct(pressure(e.results).survival_rate ?? 0) },
    { label: 'T-Spin/100手', value: (e) => fmt.n2(pressure(e.results).tspins_per_100 ?? 0) },
  ],
}

export function TetrisStatsPage() {
  return <TrainingStats config={CONFIG} />
}
