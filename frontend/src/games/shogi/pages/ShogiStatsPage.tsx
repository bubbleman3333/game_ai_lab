// 将棋 AI の強さ。教師あり学習の推移（テスト局面での正解率）と、人との対局成績を出す。

import { useEffect, useState } from 'react'
import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'
import { fetchLevels, fetchSummary, type SummaryRow } from '../api/shogi'

interface TestResult {
  policy_accuracy: number
  value_accuracy: number
  policy_loss: number
  value_loss: number
}
type Results = { test?: TestResult }

const CONFIG: StatsConfig<Results> = {
  game: 'shogi',
  title: '将棋 AI の強さ',
  evalNote: '学習に使っていない対局の局面で、強い AI と同じ手を選べた割合など（dlshogi 系で 40〜50% が目安）',
  evalCharts: [
    { title: '指し手の一致率', value: (e) => e.results.test?.policy_accuracy ?? 0, format: fmt.pct },
    { title: '勝敗の正解率', value: (e) => e.results.test?.value_accuracy ?? 0, format: fmt.pct },
    { title: '方策の loss', value: (e) => e.results.test?.policy_loss ?? 0, format: fmt.n3 },
  ],
  metricCharts: [
    { title: '方策の loss（学習中）', key: 'policy_loss', format: fmt.n3 },
    { title: '価値の loss（学習中）', key: 'value_loss', format: fmt.n3 },
    { title: '学習率', key: 'lr', format: fmt.n3 },
    { title: '1 秒あたりの学習局面数', key: 'positions_per_sec', format: fmt.n0 },
  ],
  table: [
    { label: '一致率', value: (e) => fmt.pct(e.results.test?.policy_accuracy ?? 0) },
    { label: '勝敗の正解率', value: (e) => fmt.pct(e.results.test?.value_accuracy ?? 0) },
  ],
  extra: <HumanRecord />,
}

function HumanRecord() {
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    fetchSummary().then(setRows).catch(() => undefined)
    fetchLevels().then((l) => setLabels(Object.fromEntries(l.map((x) => [x.id, x.label])))).catch(() => undefined)
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
                <td>{r.agent}</td><td>{labels[r.level] ?? r.level}</td><td>{r.games}</td>
                <td>{r.human_wins}</td><td>{r.human_losses}</td><td>{r.draws}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function ShogiStatsPage() {
  return <TrainingStats config={CONFIG} />
}
