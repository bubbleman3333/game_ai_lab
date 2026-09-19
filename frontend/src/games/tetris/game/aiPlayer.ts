// AI の操作役。新しいミノが出るたびに API（/api/ai/move/）に手を聞き、操作列を少しずつ実行する。
// 使い方: const ai = new AiPlayer(controller, { agent }); ai.start(); 毎フレーム ai.update(now)

import { ApiError } from '../../../api/client'
import { positionFromGame, requestMove } from '../api/ai'
import type { Action, GameController } from '../engine'

export interface AiOptions {
  /** 使う AI の ID（/api/ai/agents/ の id）。空なら既定 */
  agent?: string
  /** 1 操作ごとの間隔（ms）。0 なら一瞬で置く */
  actionDelayMs: number
  /** 1 手にかける時間（ms。ミノが出てからハードドロップまで）。1000 / PPS。速さの調整用 */
  pieceDelayMs: number
}

export const DEFAULT_AI_OPTIONS: AiOptions = { actionDelayMs: 30, pieceDelayMs: 150 }

type State = 'idle' | 'thinking' | 'acting' | 'waiting' | 'stopped'

const RETRY_MS = 1000 // サーバーの再起動などで失敗したとき、聞き直すまでの時間

export class AiPlayer {
  private controller: GameController
  opts: AiOptions
  /** エラーを知らせる。null はエラーが解消したとき */
  onError: ((message: string | null) => void) | null = null
  /** 直近の手を選んだ AI（画面表示用） */
  lastAgent: { id: string; episode: number | null } | null = null

  private state: State = 'stopped'
  private path: Action[] = []
  private nextActionAt = 0
  private pieceStartedAt = 0
  private lastDropAt: number | null = null // 直前にハードドロップした時刻（PPS をずれなく保つため）
  private generation = 0 // stop() 後に返ってきた応答を捨てるため
  private retryAt = 0
  private failing = false

  constructor(controller: GameController, opts: Partial<AiOptions> = {}) {
    this.controller = controller
    this.opts = { ...DEFAULT_AI_OPTIONS, ...opts }
  }

  /** 動かし始める（stop の後にもう一度呼んでもよい） */
  start(): void {
    this.generation++
    this.path = []
    this.lastDropAt = null
    this.state = 'idle'
  }

  stop(): void {
    this.state = 'stopped'
    this.generation++
  }

  update(now: number): void {
    const g = this.controller.game
    if (this.state === 'stopped' || g.over || this.controller.paused) return

    if (this.state === 'waiting') {
      if (now >= this.retryAt) this.state = 'idle'
      return
    }
    if (this.state === 'idle' && g.current) {
      this.think(now)
      return
    }
    if (this.state !== 'acting') return
    while (this.path.length && now >= this.nextActionAt) {
      const a = this.path.shift()!
      if (a === 'HD' && now - this.pieceStartedAt < this.opts.pieceDelayMs) {
        this.path.unshift(a)
        this.nextActionAt = this.pieceStartedAt + this.opts.pieceDelayMs
        return
      }
      const ok = this.controller.act(a, now)
      if (!ok && a !== 'HD') {
        // 盤面が予想と違う（おじゃまが入った等）。いったんそのまま置いて次の手で立て直す
        console.warn('AI の操作が失敗しました', a)
        this.path = ['HD']
      }
      if (a === 'HD') {
        this.lastDropAt = now
        this.state = 'idle'
        return
      }
      this.nextActionAt = this.opts.actionDelayMs > 0 ? now + this.opts.actionDelayMs : now
    }
  }

  private think(now: number): void {
    this.state = 'thinking'
    // 次のミノは前のハードドロップの瞬間に出ているので、そこから数える。
    // 画面の 1 フレーム分の遅れが毎手たまって、設定した PPS より遅くなるのを防ぐ
    const last = this.lastDropAt
    this.pieceStartedAt = last !== null && now - last < 100 ? last : now
    const gen = this.generation
    requestMove(positionFromGame(this.controller.game), this.opts.agent || undefined)
      .then((move) => {
        if (gen !== this.generation) return
        if (this.failing) {
          this.failing = false
          this.onError?.(null)
        }
        this.lastAgent = { id: move.agent, episode: move.agent_episode }
        this.path = move.path.slice()
        this.nextActionAt = performance.now()
        this.state = 'acting'
      })
      .catch((e: Error) => {
        if (gen !== this.generation) return
        // 通信できない・サーバーのエラー（再起動中など）は、少し待って聞き直す。入力の誤りなどはやめる
        const transient = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 429
        this.failing = true
        this.state = 'waiting'
        this.retryAt = performance.now() + RETRY_MS
        if (transient) {
          this.onError?.(`AI のサーバーに接続できません。${RETRY_MS / 1000} 秒ごとに再接続しています…（${e.message}）`)
        } else if (this.opts.agent) {
          // 選んだ AI が使えない（消えた・壊れた）ときは、既定の AI に切り替えて続ける
          this.onError?.(`AI「${this.opts.agent}」が使えないため、既定の AI に切り替えました（${e.message}）`)
          this.opts = { ...this.opts, agent: undefined }
        } else {
          this.onError?.(`AI が手を返せませんでした。${RETRY_MS / 1000} 秒後にもう一度試します（${e.message}）`)
        }
      })
  }
}
