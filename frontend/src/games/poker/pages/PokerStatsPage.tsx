// ポーカー AI の強さ。基準の相手との mbb/hand（1 局あたりビッグブラインドの 1/1000 が何個か）と、
// 「簡単に退場しないか」（飛んだ割合）を出す。

import { useEffect, useState } from 'react'
import { fmt, TrainingStats, type StatsConfig } from '../../../components/TrainingStats'
import { fetchPokerStats, type PokerAgentStat, type PokerHandRow } from '../api/poker'

interface Mbb {
  mbb_per_hand: number
}
interface Results {
  vs_random?: Mbb
  vs_caller?: Mbb
  vs_heuristic?: Mbb
  'vs_heuristic-loose'?: Mbb
  survival?: { bust_rate: number }
}

const CONFIG: StatsConfig<Results> = {
  game: 'poker',
  title: 'ポーカー AI の強さ',
  evalNote:
    '基準の相手との対戦成績。同じカードを配って席を入れ替えて 2 回打つ（ミラー方式）ので、'
    + 'カードの運が打ち消し合って少ない局数でも差が見える。単位の mbb/hand は'
    + '「1 局あたり、ビッグブラインドの 1/1000 が何個か」。+50 でかなり勝っている。'
    + 'なお「一番よい重み」の判定にはルールベース相手の成績だけを使う'
    + '（でたらめ相手の成績は青天井に伸びるので、手強い相手への強さが埋もれるため）。',
  evalCharts: [
    {
      title: 'ルールベース相手（かたい）',
      value: (e) => e.results.vs_heuristic?.mbb_per_hand ?? 0,
      format: fmt.n0,
      note: '本命の比較相手。プラスなら勝っている',
    },
    {
      title: 'ルールベース相手（ゆるい）',
      value: (e) => e.results['vs_heuristic-loose']?.mbb_per_hand ?? 0,
      format: fmt.n0,
    },
    {
      title: 'でたらめ相手',
      value: (e) => e.results.vs_random?.mbb_per_hand ?? 0,
      format: fmt.n0,
      note: '学習が始まればすぐ大きく勝つ。伸びが止まったら見なくてよい',
    },
    {
      title: '飛んだ割合',
      value: (e) => e.results.survival?.bust_rate ?? 0,
      format: fmt.pct,
      note: 'スタックを持ち越して片方が尽きるまで打ったとき、自分が尽きた割合。低いほど「簡単に退場しない」',
      noBaseline: true,
    },
  ],
  // ニューラルネット版（n*）と表形式版（v1-*）で記録している項目が違う。
  // 無い項目のグラフは「まだデータがありません」になるだけなので、両方並べておく
  metricCharts: [
    { title: '後悔の予想の誤差', key: 'adv_loss', format: fmt.n3, note: 'ニューラルネット版。下がるほど「どの手が得か」を言い当てられている' },
    { title: '貯めた学習データ', key: 'strategy_samples', stat: 'max', format: fmt.n0, note: 'ニューラルネット版。上限まで貯まると、以降は全反復から均等に入れ替わる' },
    { title: '覚えた場面の数', key: 'infosets', stat: 'max', format: fmt.n0, note: '表形式版のみ。情報集合の数' },
    { title: '1 秒あたりの対局数', key: 'rate', format: fmt.n0 },
  ],
  table: [
    { label: 'vs ルールベース', value: (e) => fmt.n0(e.results.vs_heuristic?.mbb_per_hand ?? 0) + ' mbb' },
    { label: '飛んだ割合', value: (e) => fmt.pct(e.results.survival?.bust_rate ?? 0) },
  ],
  extra: <HumanRecord />,
}

function HumanRecord() {
  const [agents, setAgents] = useState<PokerAgentStat[]>([])
  const [recent, setRecent] = useState<PokerHandRow[]>([])
  useEffect(() => {
    fetchPokerStats()
      .then((r) => {
        setAgents(r.agents)
        setRecent(r.recent.slice(0, 12))
      })
      .catch(() => undefined)
  }, [])
  if (!agents.length) return null
  return (
    <>
      <section className="card">
        <h2>人との対戦成績</h2>
        <p className="muted">
          mbb/hand は AI から見た値（プラスなら AI が勝っている）。
          ポーカーは運の幅が大きく、<strong>数百局では符号すら当てになりません</strong>。
          局数も一緒に見てください。
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>AI</th><th>局数</th><th>AI の収支（mbb/hand）</th><th>人の収支（チップ）</th><th>平均ポット</th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td>
                  <td>{a.hands}</td>
                  <td className={a.ai_mbb_per_hand > 0 ? 'win' : a.ai_mbb_per_hand < 0 ? 'lose' : undefined}>
                    {fmt.n0(a.ai_mbb_per_hand)}
                  </td>
                  <td>{a.human_chips}</td>
                  <td>{a.avg_pot}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {recent.length > 0 && (
        <section className="card">
          <h2>直近の局</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>AI</th><th>スタック</th><th>ポット</th><th>あなたの手</th><th>AI の手</th><th>ボード</th><th>収支</th></tr>
              </thead>
              <tbody>
                {recent.map((h, i) => (
                  <tr key={i}>
                    <td>{h.agent}</td>
                    <td>{h.stack_bb}BB</td>
                    <td>{h.pot}</td>
                    <td>{h.human_hole}</td>
                    <td>{h.ai_hole || '—'}</td>
                    <td>{h.board || '—'}</td>
                    <td className={h.human_payoff > 0 ? 'win' : h.human_payoff < 0 ? 'lose' : undefined}>
                      {h.human_payoff > 0 ? `+${h.human_payoff}` : h.human_payoff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

export function PokerStatsPage() {
  return <TrainingStats config={CONFIG} />
}
