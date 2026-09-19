// オセロ AI の強さ。自己対戦の学習の推移と、評価用の相手への勝率、人との対局成績を出す。

import { useEffect, useState } from 'react'
import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'
import { fetchSummary, type SummaryRow } from '../api/othello'
import { LEVELS } from '../engine/search'

/** rl/othello/evaluate.py の結果（相手ごと） */
interface VsResult {
  games: number
  win_rate: number
  avg_disc_diff: number
}
type Results = Record<string, VsResult | undefined>

const vs = (key: string) => (r: Results) => r[key]?.win_rate ?? 0
const diff = (key: string) => (r: Results) => r[key]?.avg_disc_diff ?? 0

const CONFIG: StatsConfig<Results> = {
  game: 'othello',
  title: 'オセロ AI の強さ',
  evalNote: '学習した評価関数で 1 手だけ読んで打ったときの勝率（対局画面では何手も先まで読むので、さらに強い）',
  evalCharts: [
    { title: '勝率 vs 重み表 2 手読み', value: (e) => vs('positional-d2')(e.results), format: fmt.pct },
    { title: '勝率 vs 重み表 1 手読み', value: (e) => vs('positional-d1')(e.results), format: fmt.pct },
    { title: '勝率 vs ランダム', value: (e) => vs('random')(e.results), format: fmt.pct },
    { title: '平均石差 vs 重み表 2 手読み', value: (e) => diff('positional-d2')(e.results), format: fmt.n1 },
  ],
  metricCharts: [
    { title: 'TD 誤差（予想と目標のずれ）', key: 'td_error', format: fmt.n3, note: '予想が当たるようになると下がる' },
    { title: '自己対戦の石差（絶対値）', key: 'abs_black_disc_diff', format: fmt.n1 },
    { title: '学習率', key: 'lr', format: fmt.n3 },
    { title: 'ε（ランダムに打つ確率）', key: 'epsilon', format: fmt.pct },
  ],
  table: [
    { label: 'vs ランダム', value: (e) => fmt.pct(vs('random')(e.results)) },
    { label: 'vs 重み表 1 手', value: (e) => fmt.pct(vs('positional-d1')(e.results)) },
    { label: 'vs 重み表 2 手', value: (e) => fmt.pct(vs('positional-d2')(e.results)) },
    { label: '石差 vs 2 手', value: (e) => fmt.n1(diff('positional-d2')(e.results)) },
  ],
  extra: <HumanRecord />,
}

/** 人と AI の対局成績（対局画面で終局すると記録される） */
function HumanRecord() {
  const [rows, setRows] = useState<SummaryRow[]>([])
  useEffect(() => {
    fetchSummary().then(setRows).catch(() => undefined)
  }, [])
  if (!rows.length) return null
  return (
    <section className="card">
      <h2>人との対局成績</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>AI</th><th>強さ</th><th>対局</th><th>人の勝ち</th><th>AI の勝ち</th><th>引き分け</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.agent}-${r.level}`}>
                <td>{r.agent}</td><td>{LEVELS[r.level]?.label ?? r.level}</td><td>{r.games}</td>
                <td>{r.human_wins}</td><td>{r.human_losses}</td><td>{r.draws}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function OthelloStatsPage() {
  return <TrainingStats config={CONFIG} />
}
