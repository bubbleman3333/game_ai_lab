// テトリス AI の強さ。表示する項目だけを決め、画面は共通の TrainingStats に任せる。

import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'

/** rl/tetris/evaluate.py の結果（モード別） */
interface ModeResult {
  avg_lines: number
  avg_attack: number
  attack_per_piece: number
  tspins_per_100: number
  tetrises_per_100: number
  survival_rate: number
}
type Results = Record<'solo' | 'pressure', ModeResult | undefined>

const solo = (r: Results) => r.solo ?? ({} as ModeResult)
const pressure = (r: Results) => r.pressure ?? ({} as ModeResult)

const CONFIG: StatsConfig<Results> = {
  game: 'tetris',
  title: 'テトリス AI の強さ',
  baselineRun: 'heuristic-baseline',
  baselineLabel: 'ヒューリスティック',
  evalNote: '決まった seed で遊ばせた平均（最大 300 手）',
  evalCharts: [
    { title: 'ひとりで消したライン数', value: (e) => solo(e.results).avg_lines ?? 0, format: fmt.n1 },
    { title: 'おじゃまありの火力', value: (e) => pressure(e.results).avg_attack ?? 0, format: fmt.n1 },
    { title: 'おじゃまありの生存率', value: (e) => pressure(e.results).survival_rate ?? 0, format: fmt.pct },
    { title: '1 手あたりの火力', value: (e) => pressure(e.results).attack_per_piece ?? 0, format: fmt.n2 },
  ],
  metricCharts: [
    { title: '消したライン数', key: 'lines', format: fmt.n1 },
    { title: '火力', key: 'attack', format: fmt.n1 },
    { title: '置いたミノ数', key: 'pieces', format: fmt.n1 },
    { title: 'T-Spin で消した回数', key: 'tspin_clears', format: fmt.n2 },
    { title: 'loss（予測と目標のずれ）', key: 'loss', format: fmt.n3, note: '下がって落ち着けば学習が安定しています' },
    { title: 'ε（ランダムに打つ確率）', key: 'epsilon', format: fmt.pct },
  ],
  table: [
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
