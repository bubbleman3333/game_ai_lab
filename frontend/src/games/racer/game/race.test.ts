// レース 1 回ぶんの進行（カウントダウン・周回の計測・順位・ゴール）のテスト。
// 物理そのものは engine/engine.test.ts で Python 版と突き合わせているので、ここでは
// 「その上に乗っている進行の管理」だけを見る。

import { describe, expect, it } from 'vitest'
import * as CO from '../engine/course'
import * as P from '../engine/physics'
import { COUNTDOWN, formatTime, Race, type RaceEvent } from './race'

const NO_INPUT: [number, number, number] = [0, 0, -1]

/**
 * 実時間で seconds 秒ぶん進める。
 * Race.update は「まとめて進めない」制限があるので、小刻みに呼ぶ必要がある。
 */
function advance(race: Race, seconds: number, input: [number, number, number] = NO_INPUT): RaceEvent[] {
  const events: RaceEvent[] = []
  for (let t = 0; t < seconds; t += 0.1) events.push(...race.update(0.1, input))
  return events
}

/** 学習なしの運転者だけで 1 レース走りきる。戻り値は起きた出来事 */
function runRace(race: Race, maxSeconds = 300): RaceEvent[] {
  const events: RaceEvent[] = []
  for (let i = 0; i < maxSeconds * 10 && !race.finished; i++) {
    events.push(...race.update(0.1, NO_INPUT))
  }
  return events
}

describe('レースの進行', () => {
  it('カウントダウンのあいだは誰も動かない', () => {
    const race = new Race('meadow', [{ name: 'A', kind: 'heuristic', carId: 'balanced' }])
    expect(race.time).toBeCloseTo(-COUNTDOWN, 5)
    expect(race.started).toBe(false)
    advance(race, COUNTDOWN - 0.5)
    expect(race.started).toBe(false)
    expect(Math.hypot(race.racers[0].state.vx, race.racers[0].state.vz)).toBe(0)
    advance(race, 1.0)
    expect(race.started).toBe(true)
  })

  for (const courseId of CO.courseIds()) {
    it(`${courseId}: 学習なしの運転者が最後まで走りきる`, () => {
      const race = new Race(courseId, [{ name: 'A', kind: 'heuristic', carId: 'balanced' }])
      const events = runRace(race)
      const me = race.racers[0]
      expect(race.finished).toBe(true)
      expect(me.finishedAt).not.toBeNull()
      expect(me.lapTimes).toHaveLength(race.laps)
      // 各周のタイムを足すと総合タイムになる
      const sum = me.lapTimes.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(me.finishedAt!, 5)
      // 1 周は 10〜90 秒のあいだに収まる（コースの長さと車の速さから）
      for (const t of me.lapTimes) expect(t).toBeGreaterThan(10)
      for (const t of me.lapTimes) expect(t).toBeLessThan(90)
      expect(race.bestLap(me)).toBe(Math.min(...me.lapTimes))
      // 周回は必要な数ちょうど（余分に数えていない）
      expect(events.filter((e) => e.kind === 'lap')).toHaveLength(race.laps)
      expect(events.filter((e) => e.kind === 'finish')).toHaveLength(1)
    })
  }

  it('速い車のほうが先にゴールし、順位もそのとおりになる', () => {
    const race = new Race('meadow', [
      { name: '速い', kind: 'heuristic', carId: 'balanced', skill: 1 },
      { name: '遅い', kind: 'heuristic', carId: 'balanced', skill: 0.7 },
    ])
    runRace(race)
    const [fast, slow] = race.racers
    expect(fast.finishedAt).not.toBeNull()
    expect(slow.finishedAt).not.toBeNull()
    expect(fast.finishedAt!).toBeLessThan(slow.finishedAt!)
    expect(race.place(fast)).toBe(1)
    expect(race.place(slow)).toBe(2)
    expect(race.standings()[0].name).toBe('速い')
  })

  it('進み具合が同じなら、並び順は前に出ているほうが先', () => {
    const race = new Race('neon', [
      { name: 'A', kind: 'heuristic', carId: 'balanced' },
      { name: 'B', kind: 'heuristic', carId: 'grip' },
    ])
    advance(race, COUNTDOWN + 8)
    const [first, second] = race.standings()
    expect(first.state.prog).toBeGreaterThanOrEqual(second.state.prog)
  })

  it('人の操作がそのまま車に届く', () => {
    const race = new Race('meadow', [{ name: '私', kind: 'human', carId: 'balanced' }])
    advance(race, COUNTDOWN + 0.2)
    advance(race, 1.5, [1, 0, -1]) // 全開
    const v = Math.hypot(race.racers[0].state.vx, race.racers[0].state.vz)
    expect(v).toBeGreaterThan(10)
    expect(race.racers[0].throttle).toBe(1)
  })

  it('画面が止まっていた時間ぶんを一気に進めない', () => {
    // タブを離れて戻ったときに、何十秒ぶんもまとめて計算してしまわないこと
    const race = new Race('meadow', [{ name: 'A', kind: 'heuristic', carId: 'balanced' }])
    race.update(COUNTDOWN, NO_INPUT)
    const before = race.time
    race.update(30, NO_INPUT)
    expect(race.time - before).toBeLessThan(0.5)
  })

  it('タイムの表示', () => {
    expect(formatTime(0)).toBe('0:00.00')
    expect(formatTime(83.456)).toBe('1:23.46')
    expect(formatTime(null)).toBe('--:--.--')
  })
})

describe('スタートの並び', () => {
  it('走者は中心線の左右に分かれて並ぶ', () => {
    const race = new Race('desert', [
      { name: 'A', kind: 'human', carId: 'balanced' },
      { name: 'B', kind: 'heuristic', carId: 'balanced' },
      { name: 'C', kind: 'heuristic', carId: 'balanced' },
    ])
    const c = race.course
    const lateral = race.racers.map((r) => {
      const i = Math.trunc(r.state.seg)
      const srx = -Math.cos(c.heading[i]), srz = Math.sin(c.heading[i]) // 運転者から見た右
      return (r.state.x - c.x[i]) * srx + (r.state.z - c.z[i]) * srz
    })
    expect(lateral[0]).toBeGreaterThan(0)
    expect(lateral[1]).toBeLessThan(0)
    // 全員が道の内側にいる
    race.racers.forEach((r, k) => {
      const i = Math.trunc(r.state.seg)
      expect(Math.abs(lateral[k])).toBeLessThan(c.width[i] / 2)
      expect(r.state.on_ground).toBe(1)
    })
  })

  it('人が操作する走者をカメラが追いかける', () => {
    const race = new Race('meadow', [
      { name: 'AI', kind: 'heuristic', carId: 'balanced' },
      { name: '私', kind: 'human', carId: 'speed' },
    ])
    expect(race.player.name).toBe('私')
    expect(P.loadCar(race.player.carId).id).toBe('speed')
  })
})
