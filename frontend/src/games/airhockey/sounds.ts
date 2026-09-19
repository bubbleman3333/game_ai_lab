// エアホッケーの効果音。音の作り方は lib/sound.ts。

import { sound } from '../../lib/sound'

let lastHit = 0

export const airhockeySounds = {
  /** マレットで打った音（強さで高さを変える） */
  hit(speed: number) {
    const now = performance.now()
    if (now - lastHit < 40) return // 連続して鳴りすぎないように
    lastHit = now
    const k = Math.min(1, speed / 6)
    sound.noise({ dur: 0.04, gain: 0.15 + 0.2 * k, filter: 1500 + 2500 * k })
    sound.tone({ freq: 500 + 500 * k, dur: 0.05, type: 'triangle', gain: 0.08 + 0.1 * k })
  },
  wall() {
    sound.tone({ freq: 300, dur: 0.04, type: 'sine', gain: 0.06 })
  },
  goal(mine: boolean) {
    const notes = mine ? [0, 4, 7, 12] : [7, 3, 0]
    notes.forEach((s, i) => sound.tone({ freq: sound.note(s), dur: 0.15, type: 'square', gain: 0.07, delay: i * 0.08 }))
  },
  countdown(last: boolean) {
    sound.tone({ freq: last ? sound.note(15) : sound.note(3), dur: last ? 0.25 : 0.1, type: 'square', gain: 0.05 })
  },
  win() {
    ;[0, 4, 7, 12, 16].forEach((s, i) => sound.tone({ freq: sound.note(s + 3), dur: 0.2, type: 'triangle', gain: 0.12, delay: i * 0.1 }))
  },
  lose() {
    ;[0, -3, -7, -12].forEach((s, i) => sound.tone({ freq: sound.note(s - 2), dur: 0.25, type: 'triangle', gain: 0.1, delay: i * 0.14 }))
  },
}
