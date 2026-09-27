// ポーカー（ヘッズアップ・ノーリミット テキサスホールデム）を AI と 1 対 1 で遊ぶ画面。
//
// ルールの進行と AI の手はサーバー（backend/apps/poker）で決める。相手の手札が見えないゲームなので、
// ブラウザに渡ってくるのは「自分に見せていいもの」だけ（AI の手札はショーダウンのときだけ）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { ActionBar } from '../components/ActionBar'
import { PokerFelt } from '../components/PokerFelt'
import { pokerSounds } from '../sounds'
import { dealBase, optimisticLine, stagedView } from '../staging'
import {
  createTable, fetchAgents, fetchTable, nextHand, sendAction,
  type ActionKind, type PokerAgentDto, type PokerTableDto,
} from '../api/poker'

// 選択肢は種類ごとにまとめる（学習を重ねると 10 個以上並ぶので）
const FAMILY_GROUPS: [string, string][] = [
  ['search', 'その場で解く（ネット + ソルバー・おすすめ）'],
  ['neural', 'ニューラルネット（Deep CFR）だけ'],
  ['table', '表形式の CFR（先に作った方）'],
  ['heuristic', '比較用'],
]

const ACTION_LABELS = ['降りる', 'チェック/コール', 'ポットの0.5倍', 'ポットの1倍', 'オールイン']

// AI の手を見せる間合い（ミリ秒）。自分が打ってから AI の最初の手が出るまでの最短と、手と手の間
const AI_FIRST_PAUSE = 900
const AI_STEP_PAUSE = 700

const AGENT_KEY = 'poker.agent'
const STACK_KEY = 'poker.stack'
const TABLE_KEY = 'poker.table'
// 浅いスタックほど「降りるか突っ込むか」の勝負になり、打ち方がまったく変わる。
// AI は深さごとに別の戦略を学んでいるので、浅いところも選べるようにしておく
const STACK_CHOICES = [20, 40, 70, 100, 150, 200, 400]

/** AI がその場面で手をどう混ぜていたか（局が終わってから出す） */
function ActionMix({ probs, chosen, labels }: { probs: number[]; chosen: number; labels?: string[] }) {
  const shown = probs
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p >= 0.005)
    .sort((a, b) => b.p - a.p)
  if (shown.length <= 1) return null
  return (
    <span className="poker-mix">
      （
      {shown.map((x, k) => (
        <span key={x.i} className={x.i === chosen ? 'chosen' : undefined}>
          {k > 0 && ' / '}
          {labels?.[x.i] ?? ACTION_LABELS[x.i] ?? x.i} {Math.round(x.p * 100)}%
        </span>
      ))}
      ）
    </span>
  )
}

export function PokerPage() {
  const [agents, setAgents] = useState<PokerAgentDto[]>([])
  const [agent, setAgent] = useState(() => localStorage.getItem(AGENT_KEY) ?? '')
  const [stack, setStack] = useState(() => Number(localStorage.getItem(STACK_KEY)) || 200)
  const [table, setTable] = useState<PokerTableDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastHand = useRef(0)
  const tableRef = useRef<PokerTableDto | null>(null)
  // AI の手を少し間を置いて 1 つずつ見せている途中の状態（staging.ts）
  const [stage, setStage] = useState<{ base: PokerTableDto; final: PokerTableDto; shown: number; settled: boolean } | null>(null)
  const timers = useRef<number[]>([])
  const actedAt = useRef(0)

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }
  useEffect(() => clearTimers, [])

  const finishSounds = (next: PokerTableDto) => {
    if (next.finished && next.result) {
      const gain = next.result.payoff[next.you]
      if (next.result.busted >= 0) pokerSounds.bust()
      else if (gain > 0) pokerSounds.win()
      else if (gain < 0) pokerSounds.lose()
    }
  }

  const aiSound = (text: string) => {
    const body = text.split(': ', 2)[1] ?? ''
    if (body.startsWith('フォールド')) pokerSounds.fold()
    else if (body.startsWith('チェック')) pokerSounds.check()
    else {
      const m = /(\d+)/.exec(body)
      pokerSounds.chips(m ? Number(m[1]) : 2, 200)
    }
  }

  /** AI の手を `from` 行目から 1 つずつ見せていく。 */
  const reveal = (base: PokerTableDto, final: PokerTableDto, from: number) => {
    clearTimers()
    setStage({ base, final, shown: from, settled: true })
    const wait = Math.max(0, AI_FIRST_PAUSE - (Date.now() - actedAt.current))
    let shown = from
    const step = () => {
      shown += 1
      aiSound(final.log[shown - 1].text)
      if (shown >= final.log.length) {
        setStage(null)
        finishSounds(final)
      } else {
        setStage({ base, final, shown, settled: true })
        timers.current.push(window.setTimeout(step, AI_STEP_PAUSE))
      }
    }
    timers.current.push(window.setTimeout(step, wait))
  }

  // サーバーから局面が来たときの反映。AI の手が入っていれば、間を置いて 1 つずつ見せる
  const apply = useCallback((next: PokerTableDto) => {
    const prev = tableRef.current
    tableRef.current = next
    setTable(next)
    localStorage.setItem(TABLE_KEY, next.table_id)
    const newHand = next.hand_no !== lastHand.current
    if (newHand) {
      lastHand.current = next.hand_no
      pokerSounds.deal()
      actedAt.current = Date.now()
    }
    const aiLines = next.log.filter((l) => l.player === next.ai).length
    if (newHand && aiLines > 0) {
      reveal(dealBase(next), next, 0)
    } else if (!newHand && prev && !prev.finished && next.log.length > prev.log.length + 1) {
      reveal(prev, next, prev.log.length + 1)
    } else {
      clearTimers()
      setStage(null)
      finishSounds(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = useCallback(
    async (fn: () => Promise<PokerTableDto>) => {
      setBusy(true)
      setError(null)
      try {
        apply(await fn())
      } catch (e) {
        clearTimers()
        setStage(null)
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [apply],
  )

  const start = useCallback(
    (agentId: string, chips: number) => {
      localStorage.setItem(AGENT_KEY, agentId)
      localStorage.setItem(STACK_KEY, String(chips))
      lastHand.current = 0
      return run(() => createTable(agentId, chips))
    },
    [run],
  )

  // 最初に AI の一覧を取り、前に遊んでいたテーブルがあれば続きから
  useEffect(() => {
    let alive = true
    ;(async () => {
      let list: PokerAgentDto[] = []
      try {
        list = await fetchAgents()
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : String(e))
        return
      }
      if (!alive) return
      setAgents(list)
      const chosen = list.some((a) => a.id === agent) ? agent : list[0]?.id ?? 'heuristic'
      setAgent(chosen)
      const saved = localStorage.getItem(TABLE_KEY)
      if (saved) {
        try {
          const t = await fetchTable(saved)
          if (!alive) return
          lastHand.current = t.hand_no
          tableRef.current = t
          setTable(t)
          return
        } catch {
          localStorage.removeItem(TABLE_KEY)
        }
      }
      if (alive) await start(chosen, Number(localStorage.getItem(STACK_KEY)) || 200)
    })()
    return () => {
      alive = false
    }
    // 最初の 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onAction = (kind: ActionKind, to = 0) => {
    if (!table) return
    if (kind === 'fold') pokerSounds.fold()
    else if (kind === 'check') pokerSounds.check()
    else pokerSounds.chips(kind === 'call' ? table.actions.call_amount : to, table.table_stacks[table.you])
    // 返事を待たずに、まず自分の手だけを反映して見せる（AI の番になった、と分かるように）
    const line = optimisticLine(table, kind, to)
    const pseudo = { ...table, log: [...table.log, line] }
    clearTimers()
    actedAt.current = Date.now()
    setStage({ base: table, final: pseudo, shown: pseudo.log.length, settled: false })
    void run(() => sendAction(table.table_id, kind, to))
  }

  const agentLabel = agents.find((a) => a.id === table?.agent)?.label ?? table?.agent ?? 'AI'
  // 画面に出す局面。AI の手を見せている途中なら、その途中の局面
  const shown = table && stage ? stagedView(stage.base, stage.final, stage.shown, stage.settled) : table
  const waiting = busy || stage !== null

  return (
    <div className="page poker-page">
      <h1>ポーカー（ヘッズアップ・ノーリミット）</h1>

      <div className="card poker-setup">
        <label>
          相手の AI{' '}
          <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy}>
            {FAMILY_GROUPS.map(([family, title]) => {
              const group = agents.filter((a) => a.family === family)
              if (!group.length) return null
              return (
                <optgroup key={family} label={title}>
                  {group.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                      {a.detail ? ` / ${a.detail}` : ''}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        </label>
        <label>
          持ちチップ{' '}
          <select value={stack} onChange={(e) => setStack(Number(e.target.value))} disabled={busy}>
            {STACK_CHOICES.map((s) => (
              <option key={s} value={s}>{s}（{s / 2}BB）</option>
            ))}
          </select>
        </label>
        <button onClick={() => void start(agent, stack)} disabled={busy || !agent}>新しいテーブル</button>
        {table && <span className="muted">{table.hand_no} 局目 / ブラインド {table.blinds[0]}・{table.blinds[1]}</span>}
      </div>

      {error && <p className="error">{error}</p>}

      {table && shown ? (
        <>
          <PokerFelt table={shown} agentLabel={agentLabel} thinking={waiting} />
          <ActionBar
            table={shown}
            busy={waiting}
            onAction={onAction}
            onNext={() => void run(() => nextHand(table.table_id))}
          />
          <section className="card poker-log">
            <h2>この局の流れ</h2>
            {shown.log.length === 0 ? (
              <p className="muted">まだ何も起きていません。</p>
            ) : (
              <ol>
                {table.log.map((l, i) => (
                  <li key={i}>
                    <span className="side-label">{l.street_name}</span> {l.text}
                    {l.probs && <ActionMix probs={l.probs} chosen={l.chosen ?? -1} labels={l.labels} />}
                  </li>
                ))}
              </ol>
            )}
            {table.finished && table.log.some((l) => l.probs) && (
              <p className="muted">
                かっこの中は、AI がその場面で各手を選ぶ確率です。
                ポーカーは<strong>手を混ぜないと読まれる</strong>ので、同じ場面でも毎回同じ手を打つとは限りません。
              </p>
            )}
          </section>
        </>
      ) : (
        !error && <p className="muted">配っています…</p>
      )}

      <section className="card">
        <h2>この AI の中身</h2>
        <p>
          相手の手札が見えないので、テトリスやオセロのように「この局面の価値」を学ぶやり方
          （DQN・TD 学習）では強くなりません。決まった打ち方は必ず読まれるので、
          <strong>手を確率で混ぜる</strong>必要があります。1 対 1 のポーカーでは、
          <strong>ナッシュ均衡</strong>（GTO）に沿った戦略は
          <strong>どんな相手にも期待値で負けない</strong>ことが分かっています。
        </p>
        <p>
          本命の「その場で解く」AI は、GTO Wizard などの<strong>ソルバー</strong>と同じ考え方です。
          いま目の前の局面について、あなたと AI が持ちうる手札 1326 通りの分布（レンジ）を持ち歩き、
          この先の賭けの木を <strong>CFR+</strong>（反事実的後悔最小化）で数百回反復して均衡に近い
          戦略を求め、自分の実際の手札の分から手を引きます。1 手に 1〜2 秒かかるのはこのためです。
        </p>
        <p className="muted">
          学習したニューラルネット（Deep CFR）は「あなたがその手札ならこう打つ確率」を推定する
          <strong>相手のモデル</strong>として使います（ソルバー自身の均衡戦略と半々で混ぜます）。
          「ネットだけ」の AI はそのネットの平均戦略でそのまま打つもので、比較用です。
          あなたは好きな額を賭けられますが、AI が選べるのは
          「フォールド・チェック/コール・ポットの 0.5 倍・1 倍・オールイン」なので、
          中途半端な額は一番近いものとして扱われます。
        </p>
      </section>
    </div>
  )
}
