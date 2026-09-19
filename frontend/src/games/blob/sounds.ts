// ブロブチェインの効果音。連鎖が続くほど音が上がっていく。

import { sound } from '../../lib/sound'
import type { BlobController, BlobEvent } from './engine/controller'

// 連鎖ごとの音階（ドレミ…と上がる）
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24]

export const blobSounds = {
  move() {
    sound.tone({ freq: 700, dur: 0.025, type: 'square', gain: 0.025 })
  },
  rotate() {
    sound.tone({ freq: 900, to: 1150, dur: 0.05, type: 'triangle', gain: 0.06 })
  },
  land() {
    sound.tone({ freq: 180, to: 120, dur: 0.08, type: 'sine', gain: 0.18 })
  },
  pop(chain: number) {
    const base = SCALE[Math.min(chain - 1, SCALE.length - 1)]
    sound.noise({ dur: 0.08, gain: 0.2, filter: 2500 + chain * 400 })
    ;[0, 4, 7].forEach((s, i) => sound.tone({ freq: sound.note(base + s), dur: 0.18, type: 'triangle', gain: 0.1, delay: i * 0.04 }))
    if (chain >= 4) sound.tone({ freq: sound.note(base + 12), dur: 0.35, type: 'sine', gain: 0.08, delay: 0.12 })
  },
  allClear() {
    ;[0, 4, 7, 12, 16, 19, 24].forEach((s, i) => sound.tone({ freq: sound.note(s + 3), dur: 0.18, type: 'square', gain: 0.05, delay: i * 0.07 }))
  },
  garbage(count: number) {
    sound.noise({ dur: 0.2 + Math.min(count, 30) * 0.01, gain: 0.25, filter: 350 })
    sound.tone({ freq: 90, to: 50, dur: 0.25, type: 'sine', gain: 0.22 })
  },
  over() {
    ;[0, -3, -7, -12].forEach((s, i) => sound.tone({ freq: sound.note(s - 3), dur: 0.3, type: 'triangle', gain: 0.1, delay: i * 0.16 }))
  },
  win() {
    ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: sound.note(s + 5), dur: 0.22, type: 'square', gain: 0.06, delay: i * 0.1 }))
  },
  countdown(last: boolean) {
    sound.tone({ freq: last ? sound.note(15) : sound.note(3), dur: last ? 0.25 : 0.1, type: 'square', gain: 0.05 })
  },
}

/** コントローラーの出来事に合わせて音を鳴らす */
export function attachBlobSounds(c: BlobController): () => void {
  return c.on((e: BlobEvent) => {
    if (e.type === 'move') blobSounds.move()
    else if (e.type === 'rotate') blobSounds.rotate()
    else if (e.type === 'lock') blobSounds.land()
    else if (e.type === 'pop') blobSounds.pop(e.step.chain)
    else if (e.type === 'allClear') blobSounds.allClear()
    else if (e.type === 'garbage') blobSounds.garbage(e.count)
    else if (e.type === 'over') blobSounds.over()
  })
}
