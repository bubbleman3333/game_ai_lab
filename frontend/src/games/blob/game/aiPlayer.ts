// AI の操作役。新しい組が出るたびに API（/api/blob/move/）に手を聞き、操作列を少しずつ実行する。
// 使い方: const ai = new BlobAiPlayer(controller, { agent }); ai.start(); 毎フレーム ai.update(now)
//
// 「お手本」（一人用で置き場所だけ教えてもらう）にも同じ仕組みを使う。advise: true にすると
// 手を聞くだけで操作はしない（hint に置き場所が入る）。

import { ApiError } from '../../../api/client'
import { positionFromGame, requestBlobMove } from '../api/ai'
import type { BlobAction, BlobMoveResponse } from '../api/types'
import type { BlobController } from '../engine/controller'

export interface BlobAiOptions {
  /** 使う AI の ID（/api/blob/agents/ の id）。空なら既定 */
  agent?: string
  /** 1 操作ごとの間隔（ms）。0 なら一瞬で置く */
  actionDelayMs: number
  /** 1 組にかける時間（ms。組が出てから落とすまで）。1000 / PPS */
  pairDelayMs: number
  /** true なら手を聞くだけで動かさない（お手本表示） */
  advise?: boolean
}

export const DEFAULT_BLOB_AI_OPTIONS: BlobAiOptions = { actionDelayMs: 40, pairDelayMs: 500 }

/** AI の速さ。PPS（1 秒に置く組の数）で指定する */
const PPS_CHOICES = [0.3, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]

export const BLOB_AI_SPEEDS = [
  ...PPS_CHOICES.map((pps) => ({
    label: `${pps} PPS`,
    actionDelayMs: Math.round(Math.min(90, Math.max(15, 1000 / pps / 8))),
    pairDelayMs: Math.round(1000 / pps),
  })),
  { label: '最速', actionDelayMs: 0, pairDelayMs: 0 },
]
/** 最初に選ばれている速さ（1 PPS） */
export const DEFAULT_BLOB_AI_SPEED = PPS_CHOICES.indexOf(1)

type State = 'idle' | 'thinking' | 'acting' | 'waiting' | 'stopped'

const RETRY_MS = 1000 // サーバーの再起動などで失敗したとき、聞き直すまでの時間

export class BlobAiPlayer {
  private controller: BlobController
  opts: BlobAiOptions
  /** エラーを知らせる。null はエラーが解消したとき */
  onError: ((message: string | null) => void) | null = null
  /** 直近の手を選んだ AI（画面表示用） */
  lastAgent: { id: string; episode: number | null } | null = null
  /** 直近に返ってきた手（お手本の表示に使う） */
  hint: BlobMoveResponse | null = null

  private state: State = 'stopped'
  private path: BlobAction[] = []
  private nextActionAt = 0
  private pairStartedAt = 0
  private lastDropAt: number | null = null // 直前に落とした時刻（PPS をずれなく保つため）
  private askedFor = -1 // 何組目について聞いたか（同じ組で聞き直さないように）
  private generation = 0 // stop() 後に返ってきた応答を捨てるため
  private retryAt = 0
  private failing = false

  constructor(controller: BlobController, opts: Partial<BlobAiOptions> = {}) {
    this.controller = controller
    this.opts = { ...DEFAULT_BLOB_AI_OPTIONS, ...opts }
  }

  /** 動かし始める（stop の後にもう一度呼んでもよい） */
  start(): void {
    this.generation++
    this.path = []
    this.lastDropAt = null
    this.askedFor = -1
    this.hint = null
    this.state = 'idle'
  }

  stop(): void {
    this.state = 'stopped'
    this.generation++
  }

  update(now: number): void {
    const c = this.controller
    const g = c.game
    if (this.state === 'stopped' || c.phase === 'over' || c.paused) return

    if (this.state === 'waiting') {
      if (now >= this.retryAt) this.state = 'idle'
      return
    }
    // 連鎖・おじゃまが落ちている間は動かせない
    if (c.phase !== 'play' || !g.current) return

    if (this.state === 'idle' && this.askedFor !== g.stats.pairs) {
      this.think(now)
      return
    }
    if (this.state !== 'acting' || this.opts.advise) return

    while (this.path.length && now >= this.nextActionAt) {
      const a = this.path[0]
      if (a === 'HD' && now - this.pairStartedAt < this.opts.pairDelayMs) {
        this.nextActionAt = this.pairStartedAt + this.opts.pairDelayMs
        return
      }
      this.path.shift()
      const ok = this.act(a)
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

  private act(a: BlobAction): boolean {
    const c = this.controller
    if (a === 'L') return c.move(-1)
    if (a === 'R') return c.move(1)
    if (a === 'CW') return c.rotate(1)
    if (a === 'CCW') return c.rotate(-1)
    c.hardDrop()
    return true
  }

  private think(now: number): void {
    const g = this.controller.game
    this.state = 'thinking'
    this.askedFor = g.stats.pairs
    this.hint = null
    // 次の組は前に落とした瞬間から数える。画面の 1 フレーム分の遅れが毎手たまるのを防ぐ
    const last = this.lastDropAt
    this.pairStartedAt = last !== null && now - last < 400 ? last : now
    const gen = this.generation
    requestBlobMove(positionFromGame(g), this.opts.agent || undefined)
      .then((move) => {
        if (gen !== this.generation) return
        if (this.failing) {
          this.failing = false
          this.onError?.(null)
        }
        this.lastAgent = { id: move.agent, episode: move.agent_episode }
        this.hint = move
        this.path = move.path.slice()
        this.nextActionAt = performance.now()
        // お手本のときは操作しないので、次の組が出たらまた聞けるよう idle に戻す
        this.state = this.opts.advise ? 'idle' : 'acting'
      })
      .catch((e: Error) => {
        if (gen !== this.generation) return
        this.askedFor = -1
        // 通信できない・サーバーのエラー（再起動中など）は、少し待って聞き直す
        const transient = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 429
        this.failing = true
        this.state = 'waiting'
        this.retryAt = performance.now() + RETRY_MS
        if (e instanceof ApiError && e.code === 'no_move') {
          this.onError?.(null) // ゲームオーバーの局面。知らせることはない
          this.state = 'stopped'
        } else if (transient) {
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
