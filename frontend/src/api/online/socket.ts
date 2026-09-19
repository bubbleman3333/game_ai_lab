// オンライン対戦の WebSocket 接続。React には依存しない。

import { wsUrl } from '../client'
import type { ClientMessage, OnlineGame, ServerMessage } from './protocol'

type Handler = (msg: ServerMessage) => void

export class MatchSocket {
  private ws: WebSocket
  private handlers: Handler[] = []
  private pingTimer: number | undefined
  onClose: ((code: number) => void) | null = null

  constructor(code: string, name: string, game: OnlineGame = 'tetris') {
    this.ws = new WebSocket(wsUrl(`/ws/${game}/rooms/${encodeURIComponent(code)}/?name=${encodeURIComponent(name)}`))
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage
      for (const h of this.handlers) h(msg)
    }
    this.ws.onclose = (e) => {
      window.clearInterval(this.pingTimer)
      this.onClose?.(e.code)
    }
    this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 20_000)
  }

  subscribe(h: Handler): () => void {
    this.handlers.push(h)
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h)
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    window.clearInterval(this.pingTimer)
    this.ws.close()
  }
}
