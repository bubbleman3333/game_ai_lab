// テーブルの見た目（AI 側・ボードとポット・自分側）。表示だけで、通信はしない。
//
// 何をされたのかが一目で分かるように、席の横に**行動のバッジ**を出す。
// - 種類ごとに色を変える（フォールド＝灰、チェック＝青、コール＝緑、レイズ＝橙、オールイン＝赤）
// - 新しい行動はポンと出るアニメーション付き（行動ごとに key を変えて描き直す）
// - AI は 1 回の応答で「コール → 次のストリートでチェック」のように 2 手打つことがあるので、
//   **自分の直前の行動より後の AI の行動を全部**並べる。ストリートが変わっていたら小さく添える
// - サーバーが解いている間（1〜2 秒）は「考え中」を出す

import type { PokerLogLine, PokerTableDto } from '../api/poker'
import { CardSlot, PlayingCard } from './PlayingCard'

const BOARD_SLOTS = 5

interface Props {
  table: PokerTableDto
  /** AI の名前（表示用） */
  agentLabel: string
  /** サーバーに手を送って返事を待っている（AI が考えている） */
  thinking?: boolean
}

export function PokerFelt({ table, agentLabel, thinking }: Props) {
  const { you, ai, result } = table
  const showdown = Boolean(result?.showdown)
  // 局の途中は「持ち越しのスタック − この局で出した分」が今の残り。
  // 局が終わると committed は精算済みなので table_stacks がそのまま残りになる
  const live = (p: number) => (table.finished ? table.table_stacks[p] : table.table_stacks[p] - table.committed[p])
  // 返事を待っている間は、画面上の局面はまだ古い（自分の手番のまま）なので、手番の印は AI に付ける
  const waiting = Boolean(thinking) && !table.finished
  return (
    <div className="poker-felt">
      <Seat
        name={agentLabel}
        isAi
        stack={live(ai)}
        bet={table.street_bet[ai]}
        cards={table.ai_hole ?? undefined}
        hidden={!showdown}
        button={table.button === ai}
        turn={table.to_act === ai || waiting}
        handName={showdown ? result?.ai_hand ?? null : null}
        won={result ? result.winner === ai : false}
        actions={recentActions(table.log, ai)}
        currentStreet={table.street}
        handNo={table.hand_no}
        folded={result?.folded === ai}
        thinking={waiting}
      />

      <TurnBanner table={table} thinking={waiting} />

      <div className="poker-middle">
        <div className="poker-board">
          {Array.from({ length: BOARD_SLOTS }, (_, i) =>
            table.board[i] ? <PlayingCard key={i} card={table.board[i]} /> : <CardSlot key={i} />,
          )}
        </div>
        <div className="poker-pot">
          <span className="side-label">ポット</span>
          <strong>{table.pot}</strong>
          <span className="muted">{table.street_name}</span>
        </div>
      </div>

      <Seat
        name="あなた"
        stack={live(you)}
        bet={table.street_bet[you]}
        cards={table.your_hole}
        button={table.button === you}
        turn={table.to_act === you && !waiting}
        handName={showdown ? result?.human_hand ?? null : null}
        won={result ? result.winner === you : false}
        actions={recentActions(table.log, you).slice(-1)}
        currentStreet={table.street}
        handNo={table.hand_no}
        folded={result?.folded === you}
      />
    </div>
  )
}

/** いま何が起きていて、誰の番か。ボードの上に 1 行で出す。 */
function TurnBanner({ table, thinking }: { table: PokerTableDto; thinking: boolean }) {
  if (table.finished) return null
  const aiActs = recentActions(table.log, table.ai)
  const aiLast = aiActs.length ? aiActs[aiActs.length - 1].line : null
  const aiSaid = aiLast && aiLast.street === table.street ? (aiLast.text.split(': ', 2)[1] ?? aiLast.text) : null
  if (table.to_act !== table.you || thinking) {
    return (
      <div className="poker-turn ai">
        <span className="poker-turn-who">AI の番</span>
        <span>{thinking ? '考えています…' : '待っています'}</span>
      </div>
    )
  }
  let situation: string
  if (table.to_call > 0) {
    situation = `${aiSaid ? `AI が「${aiSaid}」。` : ''}コールするなら ${table.to_call}。レイズかフォールドもできます`
  } else if (aiSaid) {
    situation = `AI は「${aiSaid}」。チェックかベットができます`
  } else {
    situation = 'あなたから。チェックかベットができます'
  }
  return (
    <div className="poker-turn you">
      <span className="poker-turn-who">▶ あなたの番</span>
      <span>{situation}</span>
    </div>
  )
}

/** `player` の行動のうち、相手が最後に行動してから後のもの（何も無ければ最後の 1 つ）。 */
export function recentActions(log: PokerLogLine[], player: number): { line: PokerLogLine; index: number }[] {
  const mine = log.map((line, index) => ({ line, index })).filter((x) => x.line.player === player)
  if (mine.length === 0) return []
  let lastOther = -1
  log.forEach((line, index) => {
    if (line.player !== player && line.player !== undefined) lastOther = index
  })
  const after = mine.filter((x) => x.index > lastOther)
  return after.length ? after : mine.slice(-1)
}

export type ActionKind = 'fold' | 'check' | 'call' | 'raise' | 'allin'

/** 読み上げの文（「AI: レイズ to 12」）から種類を判定する。 */
export function actionKind(text: string): ActionKind {
  const body = text.split(': ', 2)[1] ?? text
  if (body.startsWith('フォールド')) return 'fold'
  if (body.startsWith('チェック')) return 'check'
  if (body.startsWith('コール')) return 'call'
  if (body.startsWith('オールイン')) return 'allin'
  return 'raise' // 「ベット n」「レイズ to n」
}

const ICONS: Record<ActionKind, string> = { fold: '✕', check: '✓', call: '●', raise: '▲', allin: '!!' }

function ActionBadge({ line, currentStreet, big }: { line: PokerLogLine; currentStreet: number; big: boolean }) {
  const kind = actionKind(line.text)
  const body = line.text.split(': ', 2)[1] ?? line.text
  return (
    <span className={`poker-action ${kind}${big ? ' big' : ''}`}>
      <span className="poker-action-icon" aria-hidden>{ICONS[kind]}</span>
      <span>{body}</span>
      {line.street !== currentStreet && <small>{line.street_name}</small>}
    </span>
  )
}

interface SeatProps {
  name: string
  isAi?: boolean
  stack: number
  bet: number
  cards?: string[]
  hidden?: boolean
  button: boolean
  turn: boolean
  handName: string | null
  won: boolean
  /** この席の直近の行動（古い順）。最後のものを大きく出す */
  actions: { line: PokerLogLine; index: number }[]
  currentStreet: number
  handNo: number
  /** この席が降りた */
  folded?: boolean
  thinking?: boolean
}

function Seat({
  name, isAi, stack, bet, cards, hidden, button, turn, handName, won, actions, currentStreet, handNo, folded, thinking,
}: SeatProps) {
  return (
    <div className={`poker-seat${turn ? ' turn' : ''}${isAi ? ' ai' : ''}${folded ? ' folded' : ''}`}>
      <div className="poker-seat-info">
        <span className="poker-seat-name">
          {name}
          {button && <span className="poker-button" title="ボタン（スモールブラインドを出す側。プリフロップは先に行動する）">D</span>}
          {turn && <span className="poker-turn-tag">{isAi ? '手番' : 'あなたの番'}</span>}
        </span>
        <span className="muted">スタック {stack}</span>
        {bet > 0 && <span className="poker-bet">賭け {bet}</span>}
        {handName && <span className={won ? 'win' : 'muted'}>{handName}</span>}
      </div>
      <div className="poker-hole">
        {(cards ?? [undefined, undefined]).map((c, i) => (
          <PlayingCard key={i} card={c} hidden={hidden} dim={folded} />
        ))}
      </div>
      <div className="poker-actions-said" aria-live="polite">
        {thinking ? (
          <span className="poker-thinking">
            考え中<span className="dots"><i /><i /><i /></span>
          </span>
        ) : (
          actions.map((a, i) => (
            // 局番号と行動の番号を key にして、新しい行動のたびにアニメーションをやり直す
            <ActionBadge key={`${handNo}-${a.index}`} line={a.line} currentStreet={currentStreet} big={i === actions.length - 1} />
          ))
        )}
      </div>
    </div>
  )
}
