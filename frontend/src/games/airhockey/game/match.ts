// 1 試合分の進行（得点・サーブ・AI の操作）。React・DOM には依存しない。
// 物理は 1/60 秒刻みで進め（画面のフレームレートが違っても同じ動きになる）、AI は 2 ステップごとに行動を決める（学習時と同じ）。

import {
  L, W, actionToWorld, heuristicAction, initialState, observe, step, towards, type State, type StepEvents,
} from '../engine/physics'
import type { Policy } from '../engine/policy'

export const WIN_SCORE = 7
const SERVE_WAIT_MS = 1200
const AI_EVERY = 2 // 学習時の FRAME_SKIP と同じ
const MAX_STEPS_PER_FRAME = 10
// サーブ位置のばらつき（physics.py の SERVE_JITTER_X / Y と同じ）
const JITTER_X = 0.25
const JITTER_Y = 0.1

function serve(to: 0 | 1): State {
  const s = initialState(to)
  s.px += (Math.random() * 2 - 1) * JITTER_X
  s.py += (Math.random() * 2 - 1) * JITTER_Y
  return s
}

export interface MatchEvents {
  onStep?: (ev: StepEvents, s: State) => void
  onGoal?: (humanScored: boolean) => void
  onEnd?: (humanWon: boolean) => void
}

export class AirHockeyMatch {
  state: State = serve(Math.random() < 0.5 ? 0 : 1)
  humanScore = 0
  aiScore = 0
  over = false
  /** サーブ待ちの残り時間（ms）。0 ならプレー中 */
  waitMs = SERVE_WAIT_MS
  readonly startedAt = performance.now()

  private policy: Policy | null
  private aiSpeed: number
  private aiAction: [number, number] = [0, 0]
  private stepCount = 0
  private acc = 0
  private lastTime: number | null = null
  private target: [number, number] = [W / 2, L * 0.1]
  private events: MatchEvents

  /** policy が null なら学習なしの AI。aiSpeed: AI の速さ（1 = 学習時と同じ） */
  constructor(policy: Policy | null, aiSpeed: number, events: MatchEvents = {}) {
    this.policy = policy
    this.aiSpeed = aiSpeed
    this.events = events
  }

  /** マウスの位置（台の座標）。自分のマレットはここへ向かう */
  setTarget(x: number, y: number): void {
    this.target = [x, y]
  }

  /** 毎フレーム呼ぶ */
  update(now: number): void {
    if (this.over) return
    const dtMs = this.lastTime === null ? 0 : Math.min(100, now - this.lastTime)
    this.lastTime = now
    if (this.waitMs > 0) {
      this.waitMs = Math.max(0, this.waitMs - dtMs)
      return
    }
    this.acc += dtMs / 1000
    let n = 0
    while (this.acc >= 1 / 60 && n < MAX_STEPS_PER_FRAME) {
      this.acc -= 1 / 60
      n++
      if (this.physicsStep()) break
    }
  }

  /** 1 ステップ進める。得点が入ったら true */
  private physicsStep(): boolean {
    const s = this.state
    if (this.stepCount % AI_EVERY === 0) {
      if (this.policy) {
        const [ax, ay] = this.policy.act(observe(s, 1))
        const [vx, vy] = actionToWorld(ax * this.aiSpeed, ay * this.aiSpeed, 1)
        this.aiAction = [vx, vy]
      } else {
        this.aiAction = heuristicAction(s, 1, this.aiSpeed)
      }
    }
    this.stepCount++
    const [hx, hy] = towards(s, 0, this.target[0], this.target[1])
    const ev = step(s, hx, hy, this.aiAction[0], this.aiAction[1])
    this.events.onStep?.(ev, s)
    if (ev.goal === 0) return false

    const humanScored = ev.goal > 0
    if (humanScored) this.humanScore++
    else this.aiScore++
    this.events.onGoal?.(humanScored)
    if (this.humanScore >= WIN_SCORE || this.aiScore >= WIN_SCORE) {
      this.over = true
      this.events.onEnd?.(this.humanScore > this.aiScore)
      return true
    }
    // 点を取られた側からサーブ
    this.state = serve(humanScored ? 1 : 0)
    this.waitMs = SERVE_WAIT_MS
    this.acc = 0
    return true
  }
}
