// ポーカーの効果音。音の作り方は lib/sound.ts。

import { sound } from '../../lib/sound'

const n = (semi: number) => sound.note(semi)

export const pokerSounds = {
  /** カードを配る（シュッ） */
  deal() {
    for (let i = 0; i < 4; i++) {
      sound.noise({ dur: 0.05, gain: 0.12, filter: 3000, delay: i * 0.07 })
    }
  },
  check() {
    sound.noise({ dur: 0.04, gain: 0.18, filter: 1200 })
  },
  /** チップを出す（カチャカチャ）。額が大きいほど枚数が多い */
  chips(amount: number, stack: number) {
    const count = Math.max(2, Math.min(8, Math.round((amount / Math.max(1, stack)) * 14) + 2))
    for (let i = 0; i < count; i++) {
      sound.tone({ freq: 1500 + Math.random() * 700, dur: 0.03, type: 'triangle', gain: 0.07, delay: i * 0.035 })
    }
  },
  fold() {
    sound.noise({ dur: 0.12, gain: 0.14, filter: 900 })
    sound.tone({ freq: 260, to: 170, dur: 0.14, type: 'sine', gain: 0.1 })
  },
  win() {
    ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: n(s + 3), dur: 0.22, type: 'triangle', gain: 0.11, delay: i * 0.09 }))
  },
  lose() {
    ;[0, -3, -7].forEach((s, i) => sound.tone({ freq: n(s - 2), dur: 0.28, type: 'triangle', gain: 0.09, delay: i * 0.14 }))
  },
  /** 飛んだ */
  bust() {
    ;[0, -5, -10, -14].forEach((s, i) => sound.tone({ freq: n(s - 4), dur: 0.4, type: 'sawtooth', gain: 0.08, delay: i * 0.16 }))
  },
}
