// エアホッケー AI の強さ。PPO の学習の推移と、学習なしの AI との対戦成績、人との試合結果を出す。

import { useEffect, useState } from 'react'
import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'
import { fetchSummary, type SummaryRow } from '../api/airhockey'
import { LEVELS } from './AirHockeyPage'

interface VsResult {
  points: number
  won: number
  lost: number
  timeouts: number
  win_rate: number
}
type Results = Record<string, VsResult | undefined>

const CONFIG: StatsConfig<Results> = {
  game: 'airhockey',
  title: 'エアホッケー AI の強さ',
  evalNote: '学習なしの AI と 200 点ぶん打ち合ったときの得点率（時間切れは除く）',
  evalCharts: [
    { title: '得点率 vs 学習なし（全力）', value: (e) => e.results.heuristic?.win_rate ?? 0, format: fmt.pct },
    { title: '得点率 vs 学習なし（速さ 70%）', value: (e) => e.results['heuristic-slow']?.win_rate ?? 0, format: fmt.pct },
  ],
  metricCharts: [
    { title: '学習中の得点率（相手は過去の自分と学習なし AI）', key: 'rollout_win_rate', format: fmt.pct },
    { title: '行動のばらつき（探索の大きさ）', key: 'action_std', format: fmt.n2, note: '小さくなるほど迷わず動く' },
    { title: '価値の予想のずれ', key: 'value_loss', format: fmt.n3 },
    { title: '1 秒あたりの学習ステップ数', key: 'steps_per_sec', format: fmt.n0 },
  ],
  table: [
    { label: 'vs 学習なし', value: (e) => fmt.pct(e.results.heuristic?.win_rate ?? 0) },
    { label: '得点-失点', value: (e) => `${e.results.heuristic?.won ?? 0}-${e.results.heuristic?.lost ?? 0}` },
    { label: 'vs 速さ 70%', value: (e) => fmt.pct(e.results['heuristic-slow']?.win_rate ?? 0) },
  ],
  extra: <HumanRecord />,
}

function HumanRecord() {
  const [rows, setRows] = useState<SummaryRow[]>([])
  useEffect(() => {
    fetchSummary().then(setRows).catch(() => undefined)
  }, [])
  if (!rows.length) return null
  return (
    <section className="card">
      <h2>人との試合成績</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>AI</th><th>強さ</th><th>試合</th><th>人の勝ち</th><th>AI の勝ち</th><th>得点（人-AI）</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.agent}-${r.level}`}>
                <td>{r.agent}</td><td>{LEVELS[r.level]?.label ?? r.level}</td><td>{r.games}</td>
                <td>{r.human_wins}</td><td>{r.human_losses}</td><td>{r.human_points}-{r.ai_points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function AirHockeyStatsPage() {
  return <TrainingStats config={CONFIG} />
}
