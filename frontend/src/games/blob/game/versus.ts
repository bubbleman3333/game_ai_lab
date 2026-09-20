// 同じ画面での対戦（人 vs AI・AI vs AI）。連鎖の 1 段ごとに、相殺して余ったおじゃまを相手に送る。
// 送り方はオンライン対戦（onlineMatch.ts）と同じで、連鎖が進むたびに少しずつ届く。

import type { BlobController } from '../engine/controller'

/** a と b をつなぐ。戻り値を呼ぶと解除 */
export function linkBlobGarbage(a: BlobController, b: BlobController): () => void {
  const link = (from: BlobController, to: BlobController) =>
    from.on((e) => {
      if (e.type === 'pop' && e.step.sent > 0 && to.phase !== 'over') to.receiveGarbage(e.step.sent)
    })
  const offA = link(a, b)
  const offB = link(b, a)
  return () => {
    offA()
    offB()
  }
}
