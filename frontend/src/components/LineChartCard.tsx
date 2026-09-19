// 1 系列の折れ線グラフ（強さページ用）。基準線（ヒューリスティック AI の値など）を 1 本足せる。

import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

type Row = Record<string, unknown>

interface Props {
  title: string
  note?: string
  data: readonly object[]
  x: string
  y: string
  xLabel: string
  format?: (v: number) => string
  color?: string
  baseline?: { value: number; label: string } | null
}

const fmtDefault = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))

export function LineChartCard({
  title, note, data: input, x, y, xLabel, format = fmtDefault, color = 'var(--series-1)', baseline,
}: Props) {
  const data = input as Row[]
  const last = data.length ? (data[data.length - 1][y] as number | null) : null
  return (
    <figure className="chart-card">
      <figcaption>
        <span className="chart-title">{title}</span>
        {last != null && <span className="chart-last">最新 {format(last)}</span>}
      </figcaption>
      {note && <p className="chart-note">{note}</p>}
      {data.length === 0 ? (
        <div className="chart-empty">まだデータがありません</div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey={x} tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--axis)" />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }} stroke="var(--axis)" width={44} tickFormatter={format} />
            <Tooltip
              contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)' }}
              labelFormatter={(v) => `${xLabel} ${v}`}
              formatter={(v) => [format(Number(v)), title]}
              cursor={{ stroke: 'var(--axis)' }}
            />
            {baseline && (
              <ReferenceLine
                y={baseline.value}
                ifOverflow="extendDomain"
                stroke="var(--text-muted)"
                strokeDasharray="4 4"
                label={{ value: baseline.label, fill: 'var(--text-muted)', fontSize: 11, position: 'insideTopRight' }}
              />
            )}
            <Line
              type="monotone"
              dataKey={y}
              stroke={color}
              strokeWidth={2}
              dot={data.length <= 30 ? { r: 4, strokeWidth: 2, stroke: 'var(--surface-1)' } : false}
              activeDot={{ r: 5, stroke: 'var(--surface-1)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </figure>
  )
}
