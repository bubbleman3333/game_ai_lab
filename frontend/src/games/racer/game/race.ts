// レース 1 回ぶんの進行（カウントダウン・周回の計測・順位・ゴール）。
//
// 物理は engine/physics.ts（Python 版と同じ計算）。ここはその上に
// 「誰が走っていて、何周したか」を乗せているだけで、React にも three.js にも依存しない。
//
// 時間の進め方: 画面の更新間隔はまちまちなので、たまった時間を 1/60 秒ずつ消費して物理を進める
// （固定ステップ）。こうしないと、速い PC と遅い PC で走りが変わってしまう。

import * as CO from '../engine/course'
import * as P from '../engine/physics'
import type { Policy } from '../engine/policy'

export type RacerKind = 'human' | 'ai' | 'heuristic'

export interface RacerSpec {
  name: string
  carId: string
  kind: RacerKind
  /** 車体の色（省略すると carDesigns.ts の既定の色） */
  color?: number
  /** kind が 'ai' のときに使う方策 */
  policy?: Policy
  /** kind が 'heuristic' のときの強さ（1 = 全力） */
  skill?: number
}

export interface Racer extends RacerSpec {
  state: P.State
  /** 各周のタイム（秒）。入った順 */
  lapTimes: number[]
  /** ゴールした時刻（秒）。まだならnull */
  finishedAt: number | null
  /** 直前に入れたステア（タイヤの向きの表示に使う） */
  steer: number
  /** 直前に決めたアクセル（HUD の表示に使う） */
  throttle: number
  /** 通算のトリック回数 */
  tricks: number
  /** 落ちた回数 */
  falls: number
}

export interface RaceEvent {
  /** 何番目の走者か */
  who: number
  kind: 'lap' | 'finish' | 'trick' | 'fall' | 'land' | 'hit' | 'boost'
  /** lap なら周回数、trick なら回転数 */
  value?: number
}

export const COUNTDOWN = 3.2 // スタートまでの秒数

export class Race {
  readonly course: CO.Course
  readonly laps: number
  readonly racers: Racer[]
  /** スタートしてからの時間（秒）。カウントダウン中はマイナス */
  time = -COUNTDOWN
  private carOf = new Map<string, P.Car>()
  private acc = 0

  constructor(courseId: string, specs: RacerSpec[], laps?: number) {
    this.course = CO.load(courseId)
    this.laps = laps ?? this.course.laps
    // スタートは中心線に沿って横 2 列に並べる（後ろの走者ほど少し手前）
    this.racers = specs.map((spec, i) => {
      const lane = (i % 2 === 0 ? 1 : -1) * (this.course.width[0] / 4)
      const seg = CO.mod(-Math.floor(i / 2) * 6, this.course.n)
      return {
        ...spec,
        state: P.initialState(this.course, seg, lane, 0),
        lapTimes: [], finishedAt: null, steer: 0, throttle: 0, tricks: 0, falls: 0,
      }
    })
    for (const spec of specs) this.carOf.set(spec.carId, P.loadCar(spec.carId))
  }

  car(r: Racer): P.Car { return this.carOf.get(r.carId)! }

  get started(): boolean { return this.time >= 0 }
  get finished(): boolean { return this.racers.every((r) => r.finishedAt !== null) }
  /** 人が操作する走者（いなければ 0 番） */
  get player(): Racer { return this.racers.find((r) => r.kind === 'human') ?? this.racers[0] }

  /** 進んだ距離の多い順。ゴール済みはタイムの早い順で先に並ぶ */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      if (a.finishedAt !== null || b.finishedAt !== null) {
        return (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity)
      }
      return b.state.prog - a.state.prog
    })
  }

  place(r: Racer): number { return this.standings().indexOf(r) + 1 }

  /** いちばん速かった周（秒）。1 周もしていなければ null */
  bestLap(r: Racer): number | null {
    return r.lapTimes.length ? Math.min(...r.lapTimes) : null
  }

  /** 走者ごとの操作を決める */
  private decide(r: Racer, input: [number, number, number]): [number, number, number] {
    if (!this.started) return [0, 0, -1] // カウントダウン中は動けない
    if (r.finishedAt !== null) {
      // ゴールしたあとは学習なしの運転者が流す
      return P.heuristicAction(r.state, this.car(r), this.course, 0.7)
    }
    if (r.kind === 'human') return input
    if (r.kind === 'ai' && r.policy) {
      return r.policy.act(P.observe(r.state, this.car(r), this.course))
    }
    return P.heuristicAction(r.state, this.car(r), this.course, r.skill ?? 1)
  }

  /**
   * 実時間で dt 秒ぶん進める。input は人の操作。
   * 戻り値はその間に起きた出来事（音や演出に使う）。
   */
  update(dt: number, input: [number, number, number]): RaceEvent[] {
    const events: RaceEvent[] = []
    this.acc = Math.min(this.acc + dt, 0.25) // タブを離れて戻ったときに一気に進まないように
    while (this.acc >= P.DT) {
      this.acc -= P.DT
      this.time += P.DT
      this.racers.forEach((r, i) => {
        const [th, st, jp] = this.decide(r, input)
        r.steer = st
        r.throttle = th
        const before = r.state.boost
        const ev = P.step(r.state, this.car(r), this.course, th, st, jp)
        if (ev.lapped) {
          const done = r.state.lap
          const prev = r.lapTimes.reduce((a, b) => a + b, 0)
          r.lapTimes.push(this.time - prev)
          events.push({ who: i, kind: 'lap', value: done })
          if (done >= this.laps && r.finishedAt === null) {
            r.finishedAt = this.time
            events.push({ who: i, kind: 'finish', value: this.time })
          }
        }
        if (ev.tricks > 0) { r.tricks += ev.tricks; events.push({ who: i, kind: 'trick', value: ev.tricks }) }
        if (ev.fell) { r.falls += 1; events.push({ who: i, kind: 'fall' }) }
        if (ev.landed) events.push({ who: i, kind: 'land' })
        if (ev.hit) events.push({ who: i, kind: 'hit' })
        if (r.state.boost > before + 0.5 && ev.tricks === 0) events.push({ who: i, kind: 'boost' })
      })
    }
    return events
  }
}

/** 秒を "1:23.45" の形にする */
export function formatTime(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '--:--.--'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}
