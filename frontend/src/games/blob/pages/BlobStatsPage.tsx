// ブロブチェイン AI の強さ。表示する項目だけを決め、画面は共通の TrainingStats に任せる。

import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'

/** rl/blob/evaluate.py の結果（モード別） */
interface ModeResult {
  avg_pairs: number
  avg_sent: number
  avg_score: number
  avg_max_chain: number
  best_chain: number
  avg_fire_chain: number
  big_chains_per_game: number
  small_fires_per_game: number
  fires_per_game: number
  sent_per_pair: number
  all_clears_per_game: number
  survival_rate: number
}
type Results = Record<'solo' | 'pressure', ModeResult | undefined>

const solo = (r: Results) => r.solo ?? ({} as ModeResult)
const pressure = (r: Results) => r.pressure ?? ({} as ModeResult)

const CONFIG: StatsConfig<Results> = {
  game: 'blob',
  title: 'ブロブチェイン AI の強さ',
  baselineRun: 'heuristic-baseline',
  baselineLabel: 'ヒューリスティック',
  evalNote: '決まった seed で遊ばせた平均（最大 200 組）。「おじゃまあり」は 1 組置くごとに平均 0.6 個降ってくる。'
    + '連鎖オンリー型はおじゃま無しで学習するので、おじゃまありの成績は低く出ます',
  evalCharts: [
    { title: 'ひとり: 平均の最大連鎖', value: (e) => solo(e.results).avg_max_chain ?? 0, format: fmt.n1 },
    {
      title: 'ひとり: 撃った連鎖の平均段数', value: (e) => solo(e.results).avg_fire_chain ?? 0, format: fmt.n1,
      note: '「どれだけ我慢して組めているか」。小さく撃つほど下がります',
    },
    {
      title: 'ひとり: 大連鎖（6 段以上）の回数', value: (e) => solo(e.results).big_chains_per_game ?? 0, format: fmt.n1,
      note: '1 局あたり',
    },
    {
      title: 'ひとり: 早撃ち（2 段以下）の回数', value: (e) => solo(e.results).small_fires_per_game ?? 0, format: fmt.n1,
      note: '組みかけを壊した回数。下がるほどよい',
    },
    { title: 'おじゃまありの生存率', value: (e) => pressure(e.results).survival_rate ?? 0, format: fmt.pct },
    { title: 'おじゃまあり: 撃った連鎖の平均段数', value: (e) => pressure(e.results).avg_fire_chain ?? 0, format: fmt.n1 },
  ],
  metricCharts: [
    { title: '最大連鎖', key: 'max_chain', format: fmt.n1 },
    { title: '撃った連鎖の平均段数', key: 'avg_fire_chain', format: fmt.n2 },
    { title: '大連鎖（6 段以上）の回数', key: 'big_chains', format: fmt.n2 },
    { title: '早撃ち（2 段以下）の回数', key: 'small_fires', format: fmt.n1, note: '下がるほど我慢できています' },
    { title: '送ったおじゃま', key: 'sent', format: fmt.n1 },
    { title: '置いた組の数', key: 'pairs', format: fmt.n1 },
    { title: 'loss（予測と目標のずれ）', key: 'loss', format: fmt.n3, note: '下がって落ち着けば学習が安定しています' },
    { title: 'ε（ランダムに打つ確率）', key: 'epsilon', format: fmt.pct },
  ],
  table: [
    { label: 'ひとり: 最大連鎖', value: (e) => fmt.n1(solo(e.results).avg_max_chain ?? 0) },
    { label: 'ひとり: いちばん長い連鎖', value: (e) => fmt.n1(solo(e.results).best_chain ?? 0) },
    { label: 'ひとり: 発火の平均段数', value: (e) => fmt.n2(solo(e.results).avg_fire_chain ?? 0) },
    { label: 'ひとり: 大連鎖/局', value: (e) => fmt.n2(solo(e.results).big_chains_per_game ?? 0) },
    { label: 'ひとり: 早撃ち/局', value: (e) => fmt.n1(solo(e.results).small_fires_per_game ?? 0) },
    { label: 'ひとり: 送った数', value: (e) => fmt.n1(solo(e.results).avg_sent ?? 0) },
    { label: 'おじゃま: 発火の平均段数', value: (e) => fmt.n2(pressure(e.results).avg_fire_chain ?? 0) },
    { label: 'おじゃま: 生存率', value: (e) => fmt.pct(pressure(e.results).survival_rate ?? 0) },
  ],
}

export function BlobStatsPage() {
  return <TrainingStats config={CONFIG} />
}
