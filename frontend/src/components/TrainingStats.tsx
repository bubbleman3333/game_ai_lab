// 強さページの共通部品。どのゲームでも「学習の選択 → 要約 → 評価の推移 → 学習中の推移 → 評価の表」を出す。
// ゲームごとの違い（どの数字を出すか）は StatsConfig で渡す（games/*/stats.ts）。

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  fetchEvaluations, fetchRunMetrics, fetchRuns, syncRuns,
  type EvaluationDto, type GameName, type MetricBucket, type TrainingRunDto,
} from '../api/training'
import { LineChartCard } from './LineChartCard'

export interface EvalChart<R> {
  title: string
  value: (e: EvaluationDto<R>) => number
  format: (v: number) => string
  note?: string
}

export interface MetricChart {
  title: string
  /** metrics.jsonl の項目名 */
  key: string
  stat?: 'avg' | 'max'
  format: (v: number) => string
  note?: string
}

export interface TableColumn<R> {
  label: string
  value: (e: EvaluationDto<R>) => string
}

export interface StatsConfig<R> {
  game: GameName
  title: string
  /** 比較の基準（学習なしの AI など）の学習名。あれば基準線と表の 1 行目に出す */
  baselineRun?: string
  baselineLabel?: string
  evalNote: string
  evalCharts: EvalChart<R>[]
  metricCharts: MetricChart[]
  table: TableColumn<R>[]
  /** 学習の一覧の上に出す追加の内容（人との対局成績など） */
  extra?: ReactNode
}

const STATE_LABELS = { running: '学習中', finished: '完了', stopped: '中断' } as const

export function TrainingStats<R>({ config }: { config: StatsConfig<R> }) {
  const { game, baselineRun } = config
  const [runs, setRuns] = useState<TrainingRunDto[]>([])
  const [selected, setSelected] = useState('')
  const [bucket, setBucket] = useState(50)
  const [points, setPoints] = useState<MetricBucket[]>([])
  const [evals, setEvals] = useState<EvaluationDto<R>[]>([])
  const [baseline, setBaseline] = useState<EvaluationDto<R> | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    const list = await fetchRuns(game)
    setRuns(list)
    setSelected((cur) => cur || list.find((r) => r.name !== baselineRun)?.name || '')
    if (baselineRun && list.some((r) => r.name === baselineRun)) {
      const b = await fetchEvaluations<R>(game, baselineRun)
      setBaseline(b.length ? b[b.length - 1] : null)
    }
  }, [game, baselineRun])

  const loadRun = useCallback(async () => {
    if (!selected) return
    setPoints((await fetchRunMetrics(game, selected, bucket)).points)
    setEvals(await fetchEvaluations<R>(game, selected))
  }, [game, selected, bucket])

  useEffect(() => {
    // 開いたときに最新の学習結果を取り込んでから表示する（取り込みが許されていない環境ではそのまま表示）
    syncRuns()
      .catch(() => undefined)
      .then(loadRuns)
      .catch((e: Error) => setError(e.message))
  }, [loadRuns])
  useEffect(() => {
    loadRun().catch((e: Error) => setError(e.message))
  }, [loadRun])

  const sync = async () => {
    setError(null)
    try {
      const res = await syncRuns()
      const total = res.filter((r) => r.game === game).reduce((a, r) => a + r.new_metrics, 0)
      setMessage(`取り込みました（新しい記録 ${total} 件）`)
      await loadRuns()
      await loadRun()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const run = runs.find((r) => r.name === selected)
  const best = useMemo(() => [...evals].reverse().find((e) => e.is_best) ?? null, [evals])
  const unit = ({ othello: '局', airhockey: '回', shogi: '回' } as Record<string, string>)[game] ?? 'エピソード'

  return (
    <div className="page wide">
      <h1>{config.title}</h1>
      {config.extra}
      <div className="controls-row">
        <label>
          学習
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {runs.filter((r) => r.name !== baselineRun).map((r) => (
              <option key={r.name} value={r.name}>{r.name}</option>
            ))}
          </select>
        </label>
        <label>
          まとめる数
          <select value={bucket} onChange={(e) => setBucket(Number(e.target.value))}>
            {[10, 50, 100, 250, 1000, 5000].map((b) => <option key={b} value={b}>{b} {unit}</option>)}
          </select>
        </label>
        <button onClick={sync}>最新にする</button>
      </div>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error">{error}</p>}
      {runs.length === 0 && !error && (
        <p className="muted">学習の記録がありません。学習してから「取り込む」を押してください。</p>
      )}

      {run && (
        <>
          <section className="tiles">
            <Tile label="状態" value={run.status.state ? STATE_LABELS[run.status.state] : '—'} />
            <Tile label={unit} value={`${(run.status.episode ?? 0).toLocaleString()} / ${(run.status.episodes ?? 0).toLocaleString()}`} />
            <Tile label="学習時間" value={run.status.elapsed_sec ? `${Math.round(run.status.elapsed_sec / 60)} 分` : '—'} />
            {best && config.evalCharts.slice(0, 3).map((c) => (
              <Tile key={c.title} label={`最良: ${c.title}`} value={c.format(c.value(best))}
                    sub={baseline ? `${config.baselineLabel ?? '基準'} ${c.format(c.value(baseline))}` : undefined} />
            ))}
          </section>

          <h2>評価の推移 <span className="muted small">{config.evalNote}</span></h2>
          <div className="chart-grid">
            {config.evalCharts.map((c) => (
              <LineChartCard
                key={c.title} title={c.title} note={c.note} xLabel={unit} x="episode" y="v" format={c.format}
                data={evals.map((e) => ({ episode: e.episode, v: c.value(e) }))}
                baseline={baseline ? { value: c.value(baseline), label: config.baselineLabel ?? '基準' } : null}
              />
            ))}
          </div>

          <h2>学習中の推移 <span className="muted small">{bucket} {unit}ごとの平均（ランダムな手を含む）</span></h2>
          <div className="chart-grid">
            {config.metricCharts.map((c) => (
              <LineChartCard
                key={c.title} title={c.title} note={c.note} xLabel={unit} x="episode" y="v" format={c.format}
                data={points
                  .filter((p) => p[c.stat ?? 'avg'][c.key] !== undefined)
                  .map((p) => ({ episode: p.episode, v: p[c.stat ?? 'avg'][c.key] }))}
              />
            ))}
          </div>

          <h2>評価の一覧</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{unit}</th><th>チェックポイント</th>
                  {config.table.map((c) => <th key={c.label}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {baseline && (
                  <tr className="muted">
                    <td>基準</td><td>{config.baselineLabel}</td>
                    {config.table.map((c) => <td key={c.label}>{c.value(baseline)}</td>)}
                  </tr>
                )}
                {[...evals].reverse().map((e) => (
                  <tr key={e.episode}>
                    <td>{e.episode.toLocaleString()}</td><td>{e.checkpoint}{e.is_best && ' ★'}</td>
                    {config.table.map((c) => <td key={c.label}>{c.value(e)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

export const fmt = {
  pct: (v: number) => `${Math.round(v * 100)}%`,
  n0: (v: number) => v.toFixed(0),
  n1: (v: number) => v.toFixed(1),
  n2: (v: number) => v.toFixed(2),
  n3: (v: number) => v.toFixed(3),
}
