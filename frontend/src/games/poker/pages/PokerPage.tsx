// ポーカー（ヘッズアップ・ノーリミット テキサスホールデム）を AI と 1 対 1 で遊ぶ画面。
//
// ルールの進行と AI の手はサーバー（backend/apps/poker）で決める。相手の手札が見えないゲームなので、
// ブラウザに渡ってくるのは「自分に見せていいもの」だけ（AI の手札はショーダウンのときだけ）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { ActionBar } from '../components/ActionBar'
import { PokerFelt } from '../components/PokerFelt'
import { pokerSounds } from '../sounds'
import {
  createTable, fetchAgents, fetchTable, nextHand, sendAction,
  type ActionKind, type PokerAgentDto, type PokerTableDto,
} from '../api/poker'

const AGENT_KEY = 'poker.agent'
const STACK_KEY = 'poker.stack'
const TABLE_KEY = 'poker.table'
// 浅いスタックほど「降りるか突っ込むか」の勝負になり、打ち方がまったく変わる。
// AI は深さごとに別の戦略を学んでいるので、浅いところも選べるようにしておく
const STACK_CHOICES = [20, 40, 70, 100, 150, 200, 400]

export function PokerPage() {
  const [agents, setAgents] = useState<PokerAgentDto[]>([])
  const [agent, setAgent] = useState(() => localStorage.getItem(AGENT_KEY) ?? '')
  const [stack, setStack] = useState(() => Number(localStorage.getItem(STACK_KEY)) || 200)
  const [table, setTable] = useState<PokerTableDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastHand = useRef(0)

  // 局面が変わったときに音を鳴らす（新しい局・終局）
  const apply = useCallback((next: PokerTableDto) => {
    if (next.hand_no !== lastHand.current) {
      lastHand.current = next.hand_no
      pokerSounds.deal()
    }
    if (next.finished && next.result) {
      const gain = next.result.payoff[next.you]
      if (next.result.busted >= 0) pokerSounds.bust()
      else if (gain > 0) pokerSounds.win()
      else if (gain < 0) pokerSounds.lose()
    }
    setTable(next)
    localStorage.setItem(TABLE_KEY, next.table_id)
  }, [])

  const run = useCallback(
    async (fn: () => Promise<PokerTableDto>) => {
      setBusy(true)
      setError(null)
      try {
        apply(await fn())
      } catch (e) {
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
    void run(() => sendAction(table.table_id, kind, to))
  }

  const agentLabel = agents.find((a) => a.id === table?.agent)?.label ?? table?.agent ?? 'AI'

  return (
    <div className="page poker-page">
      <h1>ポーカー（ヘッズアップ・ノーリミット）</h1>

      <div className="card poker-setup">
        <label>
          相手の AI{' '}
          <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={busy}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.infosets ? `（覚えた場面 ${a.infosets.toLocaleString()}）` : ''}
              </option>
            ))}
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

      {table ? (
        <>
          <PokerFelt table={table} agentLabel={agentLabel} />
          <ActionBar
            table={table}
            busy={busy}
            onAction={onAction}
            onNext={() => void run(() => nextHand(table.table_id))}
          />
          <section className="card poker-log">
            <h2>この局の流れ</h2>
            {table.log.length === 0 ? (
              <p className="muted">まだ何も起きていません。</p>
            ) : (
              <ol>
                {table.log.map((l, i) => (
                  <li key={i}>
                    <span className="side-label">{l.street_name}</span> {l.text}
                  </li>
                ))}
              </ol>
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
          <strong>手を確率で混ぜる</strong>必要があります。
        </p>
        <p>
          そこで <strong>CFR（反事実的後悔最小化）</strong>という方法を使っています。
          「あの場面でこの手を選んでいれば、どれだけ得だったか」という後悔をためていき、
          後悔の大きい手を選ぶ確率を上げていく方法です。1 対 1 のポーカーでは、
          これで得られる戦略は<strong>どんな相手にも期待値で負けない</strong>ことが分かっています。
          「簡単に退場しない」のはこの性質のためです。
        </p>
        <p className="muted">
          スタックが浅いときと深いときで打ち方は全く変わるので、深さ（10・20・35・50・75・100BB）ごとに
          別の戦略を学習しています。あなたは好きな額を賭けられますが、AI が知っているのは
          「ポットの 0.5 倍・1 倍・オールイン」だけなので、中途半端な額は一番近いものとして扱われます。
        </p>
      </section>
    </div>
  )
}
