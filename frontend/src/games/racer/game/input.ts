// キーボードとスマホのボタンから、車への入力（アクセル・ステア・ジャンプ）を作る。
//
// 物理が受け取るのは -1〜1 の 3 つの数だけ（engine/physics.ts の step）。
// キーは押しっぱなしで効き続けるので、押されているキーの集合を持っておいて毎フレーム読む。

export type Action = 'accel' | 'brake' | 'left' | 'right' | 'jump'

const KEY_MAP: Record<string, Action> = {
  ArrowUp: 'accel', KeyW: 'accel',
  ArrowDown: 'brake', KeyS: 'brake',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'jump', ShiftRight: 'jump',
}

// ステアを一気に最大まで切らず、少しずつ寄せる。
// 曲がれる速さは物理側でグリップに頭打ちにされているので、ここは速めでも暴れない。
// 速すぎると細かく当てにくく、遅すぎると切り返しが間に合わない
const STEER_RATE = 6.5 // 1 秒で 0 から 1 まで切れる速さ
const STEER_RETURN = 9.5 // 手を離したときに真っすぐへ戻る速さ

export class RaceInput {
  private held = new Set<Action>()
  private steerValue = 0

  /** キーボードの購読を始める。戻り値を呼ぶと購読をやめる */
  attach(target: Window | HTMLElement = window): () => void {
    const down = (e: Event) => {
      const a = KEY_MAP[(e as KeyboardEvent).code]
      if (!a) return
      e.preventDefault()
      this.held.add(a)
    }
    const up = (e: Event) => {
      const a = KEY_MAP[(e as KeyboardEvent).code]
      if (!a) return
      e.preventDefault()
      this.held.delete(a)
    }
    const blur = () => this.held.clear()
    target.addEventListener('keydown', down)
    target.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      target.removeEventListener('keydown', down)
      target.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }

  /** スマホのボタン用 */
  press(a: Action): void { this.held.add(a) }
  release(a: Action): void { this.held.delete(a) }
  isHeld(a: Action): boolean { return this.held.has(a) }
  clear(): void { this.held.clear() }

  /**
   * 今の入力を読む。dt を渡すとステアがなめらかになる。
   * autoAccel が true なら、何も押していなくてもアクセルを踏んだ扱いにする（スマホ向け）。
   */
  read(dt: number, autoAccel = false): [number, number, number] {
    const accel = this.held.has('accel')
    const brake = this.held.has('brake')
    const want = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0)
    const rate = want === 0 ? STEER_RETURN : STEER_RATE
    const diff = want - this.steerValue
    this.steerValue += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt)

    let throttle = 0
    if (accel) throttle += 1
    if (brake) throttle -= 1
    if (!accel && !brake && autoAccel) throttle = 1

    return [throttle, this.steerValue, this.held.has('jump') ? 1 : -1]
  }
}
