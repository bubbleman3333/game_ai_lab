// テトリスの効果音。音の作り方は lib/sound.ts。音色を変えたいときはここだけ直せばよい。

import { useEffect } from 'react'
import { sound } from '../../lib/sound'
import type { Action, GameController, LockResult } from './engine'

const n = (semi: number) => sound.note(semi) // A4 からの半音

export const tetrisSounds = {
  // 移動・回転は短く低めの「カチッ」。高い電子音だと軽く聞こえる
  move() {
    sound.noise({ dur: 0.018, gain: 0.12, filter: 3000 })
    sound.tone({ freq: 380, to: 300, dur: 0.02, type: 'triangle', gain: 0.06 })
  },
  rotate() {
    sound.noise({ dur: 0.02, gain: 0.1, filter: 4000 })
    sound.tone({ freq: 520, to: 440, dur: 0.03, type: 'triangle', gain: 0.07 })
  },
  hold() {
    sound.tone({ freq: 520, to: 780, dur: 0.07, type: 'triangle', gain: 0.08 })
  },
  // 置いたときの「ドスッ」。低い音を強めに、アタックのノイズで硬さを出す
  hardDrop() {
    sound.noise({ dur: 0.03, gain: 0.3, filter: 2500 })
    sound.noise({ dur: 0.09, gain: 0.25, filter: 600 })
    sound.tone({ freq: 160, to: 55, dur: 0.12, type: 'sine', gain: 0.4 })
  },
  lock() {
    sound.tone({ freq: 220, dur: 0.04, type: 'sine', gain: 0.08 })
  },
  /** 消した列の数・T-Spin・REN・B2B に応じて音を変える */
  clear(r: LockResult) {
    const combo = Math.max(0, r.combo)
    const base = combo * 1 // REN が続くほど半音ずつ上がる
    if (r.spin !== 'none') {
      // T-Spin: うねる音 + 和音
      sound.tone({ freq: n(base - 5), to: n(base + 7), dur: 0.18, type: 'sawtooth', gain: 0.07 })
      ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: n(base + 3 + s), dur: 0.2, type: 'triangle', gain: 0.1, delay: 0.05 + i * 0.04 }))
    } else if (r.lines === 4) {
      // テトリス: 明るい 4 和音
      ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: n(base + s), dur: 0.25, type: 'square', gain: 0.06, delay: i * 0.05 }))
    } else {
      // 1〜3 列: 消した数だけ音が増える
      for (let i = 0; i < r.lines; i++) sound.tone({ freq: n(base + i * 4), dur: 0.12, type: 'triangle', gain: 0.12, delay: i * 0.05 })
    }
    if (r.b2bBonus) sound.tone({ freq: n(base + 24), dur: 0.15, type: 'sine', gain: 0.06, delay: 0.2 })
    if (r.perfectClear) {
      ;[0, 4, 7, 12, 16, 19, 24].forEach((s, i) => sound.tone({ freq: n(s), dur: 0.2, type: 'square', gain: 0.05, delay: 0.25 + i * 0.07 }))
    }
  },
  garbage(lines: number) {
    sound.noise({ dur: 0.15 + Math.min(lines, 8) * 0.02, gain: 0.2, filter: 400 })
    sound.tone({ freq: 90, to: 60, dur: 0.15, type: 'sine', gain: 0.2 })
  },
  gameOver() {
    ;[0, -3, -7, -12].forEach((s, i) => sound.tone({ freq: n(s - 5), dur: 0.25, type: 'triangle', gain: 0.12, delay: i * 0.15 }))
  },
  win() {
    ;[0, 4, 7, 12].forEach((s, i) => sound.tone({ freq: n(s + 3), dur: 0.2, type: 'square', gain: 0.06, delay: i * 0.1 }))
  },
  countdown(last: boolean) {
    sound.tone({ freq: last ? n(15) : n(3), dur: last ? 0.3 : 0.12, type: 'square', gain: 0.06 })
  },
}

const ACTION_SOUNDS: Partial<Record<Action, () => void>> = {
  L: tetrisSounds.move,
  R: tetrisSounds.move,
  CW: tetrisSounds.rotate,
  CCW: tetrisSounds.rotate,
  HOLD: tetrisSounds.hold,
}

/** controller の操作・固定に合わせて音を鳴らす。戻り値を呼ぶと止まる */
export function attachTetrisSounds(controller: GameController): () => void {
  const offAction = controller.onAction((a) => ACTION_SOUNDS[a]?.())
  const offLock = controller.onLock((r) => {
    if (r.lines > 0) tetrisSounds.clear(r)
    else tetrisSounds.hardDrop()
    if (r.garbageReceived > 0) tetrisSounds.garbage(r.garbageReceived)
    if (r.gameOver) tetrisSounds.gameOver()
  })
  return () => {
    offAction()
    offLock()
  }
}

/** React から使う版 */
export function useTetrisSounds(controller: GameController | null | undefined): void {
  useEffect(() => (controller ? attachTetrisSounds(controller) : undefined), [controller])
}
