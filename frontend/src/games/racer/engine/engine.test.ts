// Python 版（backend/games/racer）と同じ結果になるかを確かめる。
// データの作り直し: cd backend; .\.venv\Scripts\python -m games.racer.fixtures
//
// ここが通らなくなったら、physics.ts / course.ts と Python 版のどちらかだけを直した可能性が高い。
// レースの物理は Python 版で AI を学習させ、その重みをブラウザで動かすので、
// 両方が同じ計算をしていないと「学習したはずの走り」がブラウザで再現されない。

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as CO from './course'
import * as P from './physics'
import { Policy } from './policy'

interface Sample {
  i: number; x: number; y: number; z: number
  width: number; bank: number; heading: number; kind: number; safe: number
}
interface CourseCase {
  id: string; n: number; spacing: number; length: number; laps: number; samples: Sample[]
}
interface StepCase {
  in: number[][]
  heur: number[][]
  heur_slow: number[][]
  ev: Record<string, number[]>
  state?: P.State[]
  obs?: number[][]
}
interface RunCase {
  course: string; car: string
  start: number[]; lane: number[]; speed: number[]
  drivers: string[]
  initial: P.State[]
  steps: StepCase[]
}

const data = JSON.parse(
  readFileSync(new URL('../../../../../shared/fixtures/racer/engine_cases.json', import.meta.url), 'utf-8'),
) as { courses: CourseCase[]; cars: P.Car[]; runs: RunCase[]; policy: { layers: { w: number[][]; b: number[] }[]; obs: number[][]; action: number[][] } }

describe('コースの組み立てが Python と一致する', () => {
  it('コースと車の一覧がそろっている', () => {
    expect(CO.courseIds()).toEqual(data.courses.map((c) => c.id))
    expect(P.carIds()).toEqual(data.cars.map((c) => c.id))
  })

  it('車の性能が同じ', () => {
    for (const want of data.cars) {
      const car = P.loadCar(want.id)
      for (const k of ['accel', 'brake', 'vmax', 'grip', 'steer', 'jump', 'air_control', 'drag'] as const) {
        expect(car[k]).toBeCloseTo(want[k], 9)
      }
    }
  })

  it('曲線を 1m ごとに並べ直した中心線が同じ', () => {
    for (const cc of data.courses) {
      const c = CO.load(cc.id)
      expect(c.n).toBe(cc.n)
      expect(c.laps).toBe(cc.laps)
      expect(c.spacing).toBeCloseTo(cc.spacing, 9)
      expect(c.length).toBeCloseTo(cc.length, 9)
      for (const s of cc.samples) {
        expect(c.x[s.i]).toBeCloseTo(s.x, 8)
        expect(c.y[s.i]).toBeCloseTo(s.y, 8)
        expect(c.z[s.i]).toBeCloseTo(s.z, 8)
        expect(c.width[s.i]).toBeCloseTo(s.width, 8)
        expect(c.bank[s.i]).toBeCloseTo(s.bank, 8)
        expect(c.heading[s.i]).toBeCloseTo(s.heading, 8)
        expect(c.kind[s.i]).toBe(s.kind)
        expect(c.safe[s.i]).toBe(s.safe)
      }
    }
  })
})

describe('走らせた結果が Python と一致する', () => {
  for (const run of data.runs) {
    it(`${run.course} / ${run.car}（${run.drivers.join('・')}）`, () => {
      const c = CO.load(run.course)
      const car = P.loadCar(run.car)
      const states: P.State[] = run.initial.map((s) => ({ ...s }))
      // 置いた直後の状態も一致していること
      states.forEach((s, i) => {
        const fresh = P.initialState(c, run.start[i], run.lane[i], run.speed[i])
        for (const f of P.FIELDS) expect(fresh[f]).toBeCloseTo(s[f], 8)
      })

      run.steps.forEach((row, t) => {
        states.forEach((s, i) => {
          // 学習なしの運転者の判断も一致していること
          const h = P.heuristicAction(s, car, c)
          const hs = P.heuristicAction(s, car, c, 0.5)
          h.forEach((v, k) => expect(v).toBeCloseTo(row.heur[i][k], 6))
          hs.forEach((v, k) => expect(v).toBeCloseTo(row.heur_slow[i][k], 6))

          const ev = P.step(s, car, c, row.in[i][0], row.in[i][1], row.in[i][2])
          expect(Number(ev.landed)).toBe(row.ev.landed[i])
          expect(ev.tricks).toBe(row.ev.tricks[i])
          expect(Number(ev.fell)).toBe(row.ev.fell[i])
          expect(Number(ev.lapped)).toBe(row.ev.lapped[i])
          expect(Number(ev.hit)).toBe(row.ev.hit[i])

          // 状態と観測は「1 ステップ進めたあと」の値を記録してある（fixtures.py と同じ順番）
          if (row.state) {
            for (const f of P.FIELDS) {
              expect(s[f]).toBeCloseTo(row.state[i][f], 6)
            }
          }
          if (row.obs) {
            const obs = P.observe(s, car, c)
            expect(obs.length).toBe(P.OBS_DIM)
            obs.forEach((v, k) => expect(v).toBeCloseTo(row.obs![i][k], 6))
          }
        })
        expect(t).toBeLessThan(run.steps.length)
      })
    })
  }
})

describe('方策の計算が Python と一致する', () => {
  it('小さなネットに観測を通す', () => {
    const p = new Policy({ version: 1, activation: 'tanh', layers: data.policy.layers })
    data.policy.obs.forEach((o, i) => {
      p.act(o).forEach((v, k) => expect(v).toBeCloseTo(data.policy.action[i][k], 5))
    })
  })
})
