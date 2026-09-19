// 1 人分のブロブチェインの状態と操作。時間に関わること（落下の速さ・アニメーション）は controller.ts。

import {
  ALL_CLEAR_BONUS, COLORS, Field, GARBAGE, H, MAX_GARBAGE_DROP, Rng, SPAWN_X, SPAWN_Y, TARGET_POINT, W,
  chainScore, childPos, type Pair,
} from './rules'

export interface PopStep {
  chain: number
  /** 消えた粒（マス番号と色）。アニメーション用 */
  cells: { i: number; color: number }[]
  score: number
  /** この段で生まれたおじゃま（相殺前） */
  attack: number
  /** 自分に来ていたおじゃまを打ち消した数 */
  cancelled: number
  /** 相手に送る数 */
  sent: number
}

export class BlobGame {
  field = new Field()
  current: Pair | null = null
  score = 0
  chain = 0
  maxChain = 0
  /** 相手から届いて、まだ降っていないおじゃま */
  pending = 0
  /** 70 点に満たずに余った得点（次の消去に持ち越す） */
  private carry = 0
  private allClearBonus = false
  over = false
  stats = { pairs: 0, sent: 0, allClears: 0 }

  private rng: Rng
  private garbageRng: Rng
  private queue: [number, number][] = []

  constructor(seed = 0) {
    this.rng = new Rng(seed)
    this.garbageRng = new Rng(seed ^ 0x5bd1e995)
    this.fill()
    this.spawn()
  }

  private fill(): void {
    while (this.queue.length < 3) this.queue.push([1 + this.rng.int(COLORS), 1 + this.rng.int(COLORS)])
  }

  /** 次と、その次の組 */
  get next(): [number, number][] {
    return this.queue.slice(0, 2)
  }

  spawn(): boolean {
    const [axis, child] = this.queue.shift()!
    this.fill()
    if (!this.field.free(SPAWN_X, SPAWN_Y)) {
      this.over = true
      this.current = null
      return false
    }
    this.current = { x: SPAWN_X, y: SPAWN_Y, rot: 0, axis, child }
    return true
  }

  canPlace(p: Pair): boolean {
    const [cx, cy] = childPos(p)
    return this.field.free(p.x, p.y) && this.field.free(cx, cy) && p.y < H && cy < H
  }

  // --- 操作 --------------------------------------------------------------------------
  move(dx: number): boolean {
    const p = this.current
    if (!p) return false
    const q = { ...p, x: p.x + dx }
    if (!this.canPlace(q)) return false
    this.current = q
    return true
  }

  /** dir: +1 右回転、-1 左回転。壁や粒にぶつかるときは軸を押し出す。左右とも挟まれていたら 180° 回す */
  rotate(dir: 1 | -1): boolean {
    const p = this.current
    if (!p) return false
    const rot = (((p.rot + dir) % 4) + 4) % 4 as Pair['rot']
    const q = { ...p, rot }
    if (this.canPlace(q)) {
      this.current = q
      return true
    }
    // 押し出し: 子が行く向きと反対へ軸を 1 マスずらす
    const [cx, cy] = childPos(q)
    const kicked = { ...q, x: q.x - (cx - q.x), y: q.y - (cy - q.y) }
    if (this.canPlace(kicked)) {
      this.current = kicked
      return true
    }
    // 左右が両方ふさがっているとき（縦のまま回せない）は上下を入れ替える
    if (rot === 1 || rot === 3) {
      const flip = { ...p, rot: ((p.rot + 2) % 4) as Pair['rot'] }
      if (this.canPlace(flip)) {
        this.current = flip
        return true
      }
      const up = { ...flip, y: flip.y + 1 }
      if (this.canPlace(up)) {
        this.current = up
        return true
      }
    }
    return false
  }

  /** 1 マス下へ。下がれなければ false（接地） */
  softDrop(): boolean {
    const p = this.current
    if (!p) return false
    const q = { ...p, y: p.y - 1 }
    if (!this.canPlace(q)) return false
    this.current = q
    return true
  }

  isGrounded(): boolean {
    const p = this.current
    return !!p && !this.canPlace({ ...p, y: p.y - 1 })
  }

  /** 着地する位置（ゴースト表示用） */
  landingY(): number {
    const p = this.current!
    let y = p.y
    while (this.canPlace({ ...p, y: y - 1 })) y--
    return y
  }

  // --- 固定と連鎖 -------------------------------------------------------------------
  /** 今の組をその場に置き、ちぎれた粒を落とす。戻り値は落ちた粒（アニメーション用） */
  lock(): [number, number, number][] {
    const p = this.current!
    const [cx, cy] = childPos(p)
    this.field.set(p.x, p.y, p.axis)
    this.field.set(cx, cy, p.child)
    this.current = null
    this.chain = 0
    this.stats.pairs++
    return this.field.applyGravity()
  }

  /** 消えるものがあれば 1 段分消して得点・おじゃまを計算する（重力はまだかけない）。なければ null */
  popStep(): PopStep | null {
    const { groups, garbage } = this.field.findPops()
    if (!groups.length) return null
    this.chain++
    this.maxChain = Math.max(this.maxChain, this.chain)
    const cells = [...groups.flat(), ...garbage].map((i) => ({ i, color: this.field.cells[i] }))
    const score = chainScore(groups, (g) => this.field.cells[g[0]], this.chain)
    for (const { i } of cells) this.field.cells[i] = 0
    this.score += score

    const points = score + this.carry
    let attack = Math.floor(points / TARGET_POINT)
    this.carry = points % TARGET_POINT
    if (this.allClearBonus) {
      attack += ALL_CLEAR_BONUS
      this.allClearBonus = false
    }
    const cancelled = Math.min(this.pending, attack)
    this.pending -= cancelled
    const sent = attack - cancelled
    this.stats.sent += sent
    return { chain: this.chain, cells, score, attack, cancelled, sent }
  }

  /** 消えた後に重力をかける。全消しになったら true（次の連鎖にボーナス） */
  settle(): { moved: [number, number, number][]; allClear: boolean } {
    const moved = this.field.applyGravity()
    const allClear = this.field.isEmpty()
    if (allClear) {
      this.allClearBonus = true
      this.stats.allClears++
    }
    return { moved, allClear }
  }

  receiveGarbage(n: number): void {
    if (n > 0) this.pending += n
  }

  /** 予告のおじゃまを降らせる（最大 30 個）。戻り値は置いたマス */
  dropGarbage(): number[] {
    const n = Math.min(this.pending, MAX_GARBAGE_DROP)
    if (n <= 0) return []
    this.pending -= n
    const perCol = new Array(W).fill(Math.floor(n / W))
    // 端数はランダムな別々の列に
    const cols = [...Array(W).keys()]
    for (let k = 0; k < n % W; k++) {
      const j = k + this.garbageRng.int(W - k)
      ;[cols[k], cols[j]] = [cols[j], cols[k]]
      perCol[cols[k]]++
    }
    const placed: number[] = []
    for (let x = 0; x < W; x++) {
      let y = 0
      while (y < H && !this.field.free(x, y)) y++
      for (let k = 0; k < perCol[x] && y < H; k++, y++) {
        this.field.set(x, y, GARBAGE)
        placed.push(y * W + x)
      }
    }
    return placed
  }
}
