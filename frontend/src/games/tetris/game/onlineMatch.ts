// オンライン対戦 1 試合分の処理。WebSocket と自分の GameController をつなぐ。React には依存しない。
//   - 自分が火力を出したら attack を送る
//   - garbage が届いたら予告に積む
//   - 盤面を定期的に state で送る（相手画面の表示用）
//   - ゲームオーバーになったら topout を送る

import type { BoardRowsText, PublicStats } from '../../../api/online/protocol'
import type { MatchSocket } from '../../../api/online/socket'
import { CELLS, Game, GameController, VISIBLE_HEIGHT } from '../engine'

const STATE_INTERVAL_MS = 150

export function boardToText(game: Game): BoardRowsText {
  const rows = game.board.colors.slice(0, VISIBLE_HEIGHT + 2).map((r) => r.map((c) => c || '.'))
  const p = game.current
  if (p) {
    for (const [dx, dy] of CELLS[p.type][p.rot]) {
      const y = p.y + dy
      if (y < rows.length) rows[y][p.x + dx] = p.type
    }
  }
  return rows.map((r) => r.join(''))
}

const publicStats = (g: Game): PublicStats => ({ pieces: g.stats.pieces, lines: g.stats.lines, attack: g.stats.attack })

export class OnlineMatch {
  readonly controller: GameController
  private socket: MatchSocket
  private lastStateAt = 0
  private lastSentVersion = -1
  private toppedOut = false
  private unsubscribe: () => void
  private offLock: () => void

  constructor(socket: MatchSocket, seed: number) {
    this.socket = socket
    this.controller = new GameController(new Game(seed))
    this.controller.paused = true
    this.offLock = this.controller.onLock((r) => {
      if (r.sent > 0) socket.send({ type: 'attack', lines: r.sent })
      if (r.gameOver) this.topOut()
    })
    this.unsubscribe = socket.subscribe((msg) => {
      if (msg.type === 'garbage') this.controller.receiveGarbage(msg.lines)
    })
  }

  start(): void {
    this.controller.paused = false
  }

  /** 相手の勝ちが決まったとき・部屋を出るときに呼ぶ */
  finish(): void {
    this.controller.paused = true
    this.unsubscribe()
    this.offLock()
  }

  update(now: number): void {
    const c = this.controller
    if (c.version !== this.lastSentVersion && now - this.lastStateAt >= STATE_INTERVAL_MS) {
      this.lastStateAt = now
      this.lastSentVersion = c.version
      this.socket.send({
        type: 'state',
        rows: boardToText(c.game),
        stats: publicStats(c.game),
        pending: c.game.pending.reduce((a, p) => a + p[0], 0),
      })
    }
  }

  private topOut(): void {
    if (this.toppedOut) return
    this.toppedOut = true
    this.socket.send({ type: 'topout', stats: publicStats(this.controller.game) })
  }
}
