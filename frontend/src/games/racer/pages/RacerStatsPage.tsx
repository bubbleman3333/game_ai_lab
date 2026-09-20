// レース AI の強さ `/racer/stats`。PPO の学習の推移と、学習なしの運転者とのタイム比べ、
// 人の走行記録を出す。表示の仕組みはほかのゲームと同じ components/TrainingStats.tsx。

import { useEffect, useState } from 'react'
import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'
import { fetchSummary, type LapRow } from '../api/racer'
import * as CO from '../engine/course'
import { formatTime } from '../game/race'

/** rl/racer/train.py が evals.jsonl に書く形 */
interface CourseResult {
  lap_sec: number
  heuristic_sec: number
  /** 学習なしのタイム ÷ AI のタイム。1 を超えたら AI のほうが速い */
  ratio: number
  falls: number
  tricks: number
  completed: number
}
type Results = Record<string, CourseResult | undefined>

const COURSES = CO.COURSE_DEFS.map((d) => ({ id: d.id, name: d.name ?? d.id }))

const CONFIG: StatsConfig<Results> = {
  game: 'racer',
  title: 'レース AI の強さ',
  evalNote: '各コースを 1 周走らせたときのタイム。学習なしの運転者のタイムと比べる（1.0 で互角）',
  evalCharts: [
    ...COURSES.map((c) => ({
      title: `${c.name}: 学習なしとのタイム比`,
      value: (e: { results: Results }) => e.results[c.id]?.ratio ?? 0,
      format: fmt.n2,
    })),
    {
      title: 'コースから落ちた回数（1 周あたり）',
      value: (e) => COURSES.reduce((a, c) => a + (e.results[c.id]?.falls ?? 0), 0) / COURSES.length,
      format: fmt.n2,
    },
    {
      title: '空中で決めたトリック（1 周あたり）',
      value: (e) => COURSES.reduce((a, c) => a + (e.results[c.id]?.tricks ?? 0), 0) / COURSES.length,
      format: fmt.n2,
    },
  ],
  metricCharts: [
    { title: '1 エピソードで進んだ距離（m）', key: 'progress', format: fmt.n0 },
    { title: '平均の速さ（m/s）', key: 'speed', format: fmt.n1 },
    { title: 'コースから落ちた回数', key: 'falls', format: fmt.n2, note: '減っていけば、無理な飛び方をしなくなったということ' },
    { title: '壁に当たった割合', key: 'hit_rate', format: fmt.pct },
    { title: '行動のばらつき（探索の大きさ）', key: 'action_std', format: fmt.n2, note: '小さくなるほど迷わず走る' },
    { title: '価値の予想のずれ', key: 'value_loss', format: fmt.n3 },
    { title: '1 秒あたりの学習ステップ数', key: 'steps_per_sec', format: fmt.n0 },
  ],
  table: COURSES.map((c) => ({
    label: c.name,
    value: (e) => {
      const r = e.results[c.id]
      return r ? `${r.lap_sec.toFixed(1)}s（学習なし ${r.heuristic_sec.toFixed(1)}s）` : '-'
    },
  })),
  extra: <HumanRecord />,
}

function HumanRecord() {
  const [rows, setRows] = useState<LapRow[]>([])
  useEffect(() => {
    fetchSummary().then(setRows).catch(() => undefined)
  }, [])
  if (!rows.length) return null
  const nameOf = (id: string) => COURSES.find((c) => c.id === id)?.name ?? id
  return (
    <section className="card">
      <h2>人の走行記録</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>コース</th><th>車</th><th>走行</th><th>ベストラップ</th><th>ベスト総合</th><th>AI との勝敗</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.course}-${r.car}`}>
                <td>{nameOf(r.course)}</td>
                <td>{r.car}</td>
                <td>{r.runs}</td>
                <td className="mono">{formatTime(r.best_lap)}</td>
                <td className="mono">{formatTime(r.best_total)}</td>
                <td>{r.wins + r.losses > 0 ? `${r.wins} 勝 ${r.losses} 敗` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function RacerStatsPage() {
  return <TrainingStats config={CONFIG} />
}
