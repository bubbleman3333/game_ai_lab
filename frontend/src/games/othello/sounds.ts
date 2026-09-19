// オセロの効果音。音の作り方は lib/sound.ts。

import { sound } from '../../lib/sound'

const n = (semi: number) => sound.note(semi)

export const othelloSounds = {
  /** 石を置く（コトッ）＋ 裏返した枚数だけ軽い音 */
  place(flipped: number) {
    sound.noise({ dur: 0.05, gain: 0.25, filter: 1800 })
    sound.tone({ freq: 320, to: 200, dur: 0.06, type: 'sine', gain: 0.18 })
    for (let i = 0; i < Math.min(flipped, 10); i++) {
      sound.tone({ freq: 1100 + i * 60, dur: 0.025, type: 'triangle', gain: 0.05, delay: 0.06 + i * 0.03 })
    }
  },
  pass() {
    sound.tone({ freq: n(0), dur: 0.12, type: 'triangle', gain: 0.1 })
    sound.tone({ freq: n(-5), dur: 0.18, type: 'triangle', gain: 0.1, delay: 0.12 })
  },
  win() {
    ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: n(s + 3), dur: 0.25, type: 'triangle', gain: 0.12, delay: i * 0.1 }))
  },
  lose() {
    ;[0, -3, -7].forEach((s, i) => sound.tone({ freq: n(s - 2), dur: 0.3, type: 'triangle', gain: 0.1, delay: i * 0.15 }))
  },
  draw() {
    ;[0, 0].forEach((_, i) => sound.tone({ freq: n(0), dur: 0.2, type: 'triangle', gain: 0.1, delay: i * 0.2 }))
  },
}
