// Python 版（backend/games/airhockey）と同じ結果になるかを確かめる。
// データの作り直し: cd backend; python -m games.airhockey.fixtures

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FIELDS, heuristicAction, initialState, observe, step, type State } from './physics'
import { Policy } from './policy'

const data = JSON.parse(
  readFileSync(new URL('../../../../../shared/fixtures/airhockey/engine_cases.json', import.meta.url), 'utf-8'),
)

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

describe('air hockey physics matches Python', () => {
  it('replays 240 steps on 4 tables', () => {
    const states: State[] = data.initial.map((s: State) => ({ ...s }))
    data.steps.forEach((st: { a0: number[][]; h1: number[][]; goal: number[]; state: State[]; obs1: number[][] }) => {
      states.forEach((s, i) => {
        const [h1x, h1y] = heuristicAction(s, 1)
        close(h1x, st.h1[i][0])
        close(h1y, st.h1[i][1])
        const ev = step(s, st.a0[i][0], st.a0[i][1], h1x, h1y)
        expect(ev.goal).toBe(st.goal[i])
        for (const f of FIELDS) close(s[f], st.state[i][f])
        observe(s, 1).forEach((v, k) => expect(v).toBeCloseTo(st.obs1[i][k], 5))
        if (ev.goal !== 0) states[i] = initialState(0)
      })
    })
  })

  it('policy forward pass', () => {
    const p = new Policy({ version: 1, activation: 'tanh', layers: data.policy.layers })
    data.policy.obs.forEach((o: number[], i: number) => {
      const [ax, ay] = p.act(o)
      expect(ax).toBeCloseTo(data.policy.action[i][0], 5)
      expect(ay).toBeCloseTo(data.policy.action[i][1], 5)
    })
  })
})
