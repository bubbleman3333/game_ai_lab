// パトカーの運転（追跡）。物理（vehicle.ts）の車に、アクセル・ハンドルを入れる運転手。
//
//   見えていて近い  相手の少し先（速度 × 時間）をめがけて突っ込む
//   見えていない    道路の格子を交差点から交差点へたどって近づく
//   引っかかった    しばらく進めなかったら、ハンドルを逆に切ってバックする
//
// ルールベースの運転手なので、将来ここを強化学習の方策に差し替えられるよう、
// 入力（相手と自分の状態）→ 出力（Controls）の形にしてある。

import { CityMap, DIRS, NODES, PITCH, nodeX } from './cityMap'
import type { Body, Controls } from './vehicle'
import { forwardSpeed, speedOf } from './vehicle'

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const nodeIndex = (v: number) => clamp(Math.round((v - nodeX(0)) / PITCH), 0, NODES - 1)

export class PoliceDriver {
  private wp: [number, number] | null = null
  private stuck = 0
  /** 低速のままの時間。長く続くと game.ts がこのパトカーを消して、別の場所に出し直す */
  stuckTime = 0
  private reverse = 0
  private reverseSteer = 0
  private reverseThrottle = -1
  /** 追跡の本気度（手配度が高いほど速く走る） */
  aggression = 1
  /** true なら追うのではなく逃げる（ミッションの標的の車） */
  flee = false
  /** true なら追跡ではなく、そばに来て止まる（職務質問） */
  approach = false

  /**
   * 次に向かう交差点を決める。hx, hz は今進んでいる向き。
   * 来た向きへ戻る道は大きく減点する（行き止まりでない限り U ターンしない）
   */
  private nextNode(from: [number, number], tx: number, tz: number, hx: number, hz: number): [number, number] {
    let best: [number, number] = from
    let bestScore = Infinity
    for (const [dx, dz] of DIRS) {
      const i = from[0] + dx, j = from[1] + dz
      if (i < 0 || j < 0 || i >= NODES || j >= NODES) continue
      let score = Math.hypot(nodeX(i) - tx, nodeX(j) - tz) * (this.flee ? -1 : 1)
      // 逃げるときは少しでたらめに曲がる（読まれにくいように）
      if (this.flee) score += Math.sin(i * 12.9898 + j * 78.233 + Math.floor(Date.now() / 7000)) * 60
      if (dx * hx + dz * hz < -0.5) score += 250
      if (score < bestScore) { bestScore = score; best = [i, j] }
    }
    return best
  }

  update(dt: number, b: Body, target: Body, sees: boolean): Controls {
    const speed = speedOf(b)
    const vf = forwardSpeed(b)
    const dist = Math.hypot(target.x - b.x, target.z - b.z)
    let ax: number, az: number
    let want: number

    if (sees && dist < 75 && !this.flee) {
      // 直接追う。近いほど「今いる場所」、遠いほど「行きそうな場所」をめがける
      const lead = clamp(dist / 22, 0, 1.2)
      ax = target.x + target.vx * lead
      az = target.z + target.vz * lead
      // すぐそばでは相手と同じくらいの速さで並走して押さえ込む（突っ込みすぎて自爆しないように）
      want = (dist < 15 ? speedOf(target) + 3 : 40) * this.aggression
      this.wp = null
    } else {
      if (!this.wp) {
        // いちばん近い交差点のうち、前にあって相手に近いもの
        const i0 = nodeIndex(b.x), j0 = nodeIndex(b.z)
        let best: [number, number] = [i0, j0]
        let bestScore = Infinity
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const i = i0 + di, j = j0 + dj
          if (i < 0 || j < 0 || i >= NODES || j >= NODES) continue
          if (di !== 0 && dj !== 0) continue
          const nx = nodeX(i) - b.x, nz = nodeX(j) - b.z
          const behind = nx * Math.sin(b.yaw) + nz * Math.cos(b.yaw) < -5 ? 150 : 0
          const score = Math.hypot(nodeX(i) - target.x, nodeX(j) - target.z) * (this.flee ? -1 : 1) + Math.hypot(nx, nz) + behind
          if (score < bestScore) { bestScore = score; best = [i, j] }
        }
        this.wp = best
      }
      let wx = nodeX(this.wp[0]), wz = nodeX(this.wp[1])
      if (Math.hypot(wx - b.x, wz - b.z) < 9) {
        const next = this.nextNode(this.wp, target.x, target.z, Math.sin(b.yaw), Math.cos(b.yaw))
        this.wp = next
        wx = nodeX(next[0]); wz = nodeX(next[1])
      }
      ax = wx; az = wz
      const toWp = Math.hypot(wx - b.x, wz - b.z)
      want = (this.flee ? (dist < 60 ? 30 : 20) : 34) * this.aggression
      // 交差点で曲がりそうなら手前で減速する
      const [dx1, dz1] = [wx - b.x, wz - b.z]
      const n1 = Math.hypot(dx1, dz1) || 1
      const after = this.nextNode(this.wp, target.x, target.z, dx1 / n1, dz1 / n1)
      const [dx2, dz2] = [nodeX(after[0]) - wx, nodeX(after[1]) - wz]
      const turning = Math.abs(dx1 * dz2 - dz1 * dx2) > Math.abs(dx1 * dx2 + dz1 * dz2)
      // 曲がれる速さ（約 11m/s）まで、ブレーキ（約 6m/s²）で落としきれる速さ
      if (turning) want = Math.min(want, Math.sqrt(11 * 11 + 2 * 6 * Math.max(toWp - 9, 0)))
    }

    // 職務質問: 近づくほどゆっくりにして、手前で止まる
    if (this.approach) want = Math.min(want, Math.max(0, (dist - 7) * 0.7))

    // ハンドル: めがける点が右にあれば右へ
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw)
    const rx = -Math.cos(b.yaw), rz = Math.sin(b.yaw)
    const lx = ax - b.x, lz = az - b.z
    const angle = Math.atan2(lx * rx + lz * rz, lx * fx + lz * fz)
    let steer = clamp(angle * 2.2, -1, 1)
    want *= clamp(1 - Math.abs(angle) * 0.55, 0.35, 1)

    // 引っかかったらバックする
    if (this.reverse > 0) {
      this.reverse -= dt
      return { throttle: this.reverseThrottle, steer: this.reverseSteer, handbrake: false }
    }
    let throttle = vf < want ? 1 : vf > want + 4 ? -0.7 : 0.15
    if (Math.abs(angle) > 1.6 && speed < 6) {
      // 真後ろ近くにいる: バックしながら向きを変える
      throttle = -1
      steer = -Math.sign(angle)
    }
    if (throttle !== 0 && speed < 1.2) this.stuck += dt
    else this.stuck = Math.max(0, this.stuck - dt * 2)
    this.stuckTime = speed < 2 ? this.stuckTime + dt : 0
    if (this.stuck > 1.3) {
      // 前へ進めないならバック、バックで詰まったなら前へ（ハンドルは逆に切る）
      this.stuck = 0
      this.reverse = 1.4
      this.reverseSteer = throttle > 0 ? -steer || 1 : steer || 1
      this.reverseThrottle = throttle > 0 ? -1 : 1
      this.wp = null
    }
    const handbrake = Math.abs(angle) > 0.9 && speed > 14
    return { throttle, steer, handbrake }
  }
}

/** 警察から見えているか（距離と、あいだに建物が無いか） */
export function canSee(map: CityMap, a: Body, b: Body, range: number): boolean {
  const d = Math.hypot(a.x - b.x, a.z - b.z)
  if (d > range) return false
  return map.lineOfSight(a.x, a.z, b.x, b.z)
}
