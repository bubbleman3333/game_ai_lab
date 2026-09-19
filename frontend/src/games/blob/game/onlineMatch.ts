// ブロブチェインのオンライン対戦 1 試合分。WebSocket と自分の BlobController をつなぐ。React には依存しない。
//   - 連鎖で相手に送る数（相殺後）が出たら attack を送る（1 通 30 個までなので分けて送る）
//   - garbage が届いたら予告に積む
//   - 盤面を定期的に state で送る（相手画面の表示用）
//   - ゲームオーバーになったら topout を送る
// 通信の形はテトリスと共通（api/online/protocol.ts）。PublicStats は
//   pieces = 置いた組の数 / lines = 最大連鎖 / attack = 送ったおじゃま の意味で使う。

import type { BoardRowsText, PublicStats } from '../../../api/online/protocol'
import type { MatchSocket } from '../../../api/online/socket'
import { BlobController } from '../engine/controller'
import { BlobGame } from '../engine/game'
import { H, W, childPos } from '../engine/rules'

const STATE_INTERVAL_MS = 150
const MAX_ATTACK_PER_MESSAGE = 30

/** 盤面を文字列に。下の行から、各行 6 文字（'0' 空き / '1'〜'4' 色 / '5' おじゃま）。落下中の組も書き込む */
export function fieldToText(game: BlobGame): BoardRowsText {
  const rows: string[][] = []
  for (let y = 0; y < H; y++) {
    const r: string[] = []
    for (let x = 0; x < W; x++) r.push(String(game.field.get(x, y)))
    rows.push(r)
  }
  const p = game.current
  if (p) {
    const [cx, cy] = childPos(p)
    if (p.y >= 0 && p.y < H) rows[p.y][p.x] = String(p.axis)
    if (cy >= 0 && cy < H) rows[cy][cx] = String(p.child)
  }
  return rows.map((r) => r.join(''))
}

export const blobPublicStats = (g: BlobGame): PublicStats => ({ pieces: g.stats.pairs, lines: g.maxChain, attack: g.stats.sent })

export class BlobOnlineMatch {
  readonly controller: BlobController
  private socket: MatchSocket
  private lastStateAt = 0
  private lastSentVersion = -1
  private toppedOut = false
  private unsubscribe: () => void
  private offEvents: () => void

  constructor(socket: MatchSocket, seed: number) {
    this.socket = socket
    this.controller = new BlobController(new BlobGame(seed))
    this.controller.paused = true
    this.offEvents = this.controller.on((e) => {
      if (e.type === 'pop' && e.step.sent > 0) {
        for (let left = e.step.sent; left > 0; left -= MAX_ATTACK_PER_MESSAGE) {
          socket.send({ type: 'attack', lines: Math.min(left, MAX_ATTACK_PER_MESSAGE) })
        }
      }
      if (e.type === 'over') this.topOut()
    })
    this.unsubscribe = socket.subscribe((msg) => {
      if (msg.type === 'garbage') this.controller.receiveGarbage(msg.lines)
    })
  }

  start(): void {
    this.controller.paused = false
  }

  /** 勝敗が決まったとき・部屋を出るときに呼ぶ */
  finish(): void {
    this.controller.paused = true
    this.unsubscribe()
    this.offEvents()
  }

  update(now: number): void {
    const c = this.controller
    c.update(now)
    if (c.version !== this.lastSentVersion && now - this.lastStateAt >= STATE_INTERVAL_MS) {
      this.lastStateAt = now
      this.lastSentVersion = c.version
      this.socket.send({ type: 'state', rows: fieldToText(c.game), stats: blobPublicStats(c.game), pending: c.game.pending })
    }
  }

  private topOut(): void {
    if (this.toppedOut) return
    this.toppedOut = true
    this.socket.send({ type: 'topout', stats: blobPublicStats(this.controller.game) })
  }
}
