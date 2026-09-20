// テーブルの見た目（AI 側・ボードとポット・自分側）。表示だけで、通信はしない。

import type { PokerTableDto } from '../api/poker'
import { CardSlot, PlayingCard } from './PlayingCard'

const BOARD_SLOTS = 5

interface Props {
  table: PokerTableDto
  /** AI の名前（表示用） */
  agentLabel: string
}

export function PokerFelt({ table, agentLabel }: Props) {
  const { you, ai, result } = table
  const showdown = Boolean(result?.showdown)
  // 局の途中は「持ち越しのスタック − この局で出した分」が今の残り。
  // 局が終わると committed は精算済みなので table_stacks がそのまま残りになる
  const live = (p: number) => (table.finished ? table.table_stacks[p] : table.table_stacks[p] - table.committed[p])
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
        turn={table.to_act === ai}
        handName={showdown ? result?.ai_hand ?? null : null}
        won={result ? result.winner === ai : false}
      />

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
        turn={table.to_act === you}
        handName={showdown ? result?.human_hand ?? null : null}
        won={result ? result.winner === you : false}
      />
    </div>
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
}

function Seat({ name, isAi, stack, bet, cards, hidden, button, turn, handName, won }: SeatProps) {
  return (
    <div className={`poker-seat${turn ? ' turn' : ''}${isAi ? ' ai' : ''}`}>
      <div className="poker-seat-info">
        <span className="poker-seat-name">
          {name}
          {button && <span className="poker-button" title="ボタン（スモールブラインドを出す側。プリフロップは先に行動する）">D</span>}
        </span>
        <span className="muted">スタック {stack}</span>
        {bet > 0 && <span className="poker-bet">賭け {bet}</span>}
        {handName && <span className={won ? 'win' : 'muted'}>{handName}</span>}
      </div>
      <div className="poker-hole">
        {(cards ?? [undefined, undefined]).map((c, i) => (
          <PlayingCard key={i} card={c} hidden={hidden} />
        ))}
      </div>
    </div>
  )
}
