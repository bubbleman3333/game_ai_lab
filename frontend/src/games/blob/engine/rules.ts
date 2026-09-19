// ブロブチェインのルール（落ち物パズル。同じ色を 4 つつなげると消え、連鎖するとおじゃまを送れる）。
// 時間（落下・アニメーション）は扱わない。controller.ts が時間に合わせてここの関数を呼ぶ。
//
// 盤面: 幅 6、高さ 13（y=0 が一番下。y=12 は画面外の 13 段目で、ここにある粒は消えない）。
// 組ぷよ（2 個 1 組）: 軸 (x, y) と子。rot 0 = 子が上、1 = 右、2 = 下、3 = 左。

export const W = 6
export const H = 13
export const VISIBLE_H = 12
export const SPAWN_X = 2
export const SPAWN_Y = 11 // この位置がふさがると負け（左から 3 列目・上から 2 段目）
export const EMPTY = 0
export const GARBAGE = 5
export const COLORS = 4
export const POP_COUNT = 4
export const TARGET_POINT = 70 // 何点で 1 個おじゃまを送るか
export const ALL_CLEAR_BONUS = 30 // 全消しした次の連鎖に上乗せするおじゃまの数
export const MAX_GARBAGE_DROP = 30 // 1 回に降るおじゃまの上限（5 段）

// 連鎖ボーナス（1 連鎖目から）・色数ボーナス・連結ボーナス（ぷよぷよ通と同じ計算）
const CHAIN_POWER = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512]
const COLOR_BONUS = [0, 0, 3, 6, 12, 24]
const GROUP_BONUS = (n: number) => (n <= 4 ? 0 : n >= 11 ? 10 : n - 3)

export interface Pair {
  x: number
  y: number
  rot: 0 | 1 | 2 | 3
  axis: number // 軸の色 1〜4
  child: number // 子の色
}

const CHILD_OFFSET: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]]

export function childPos(p: Pair): [number, number] {
  const [dx, dy] = CHILD_OFFSET[p.rot]
  return [p.x + dx, p.y + dy]
}

export class Field {
  cells = new Uint8Array(W * H)

  get(x: number, y: number): number {
    if (x < 0 || x >= W || y < 0) return -1 // 壁と床
    if (y >= H) return EMPTY
    return this.cells[y * W + x]
  }

  set(x: number, y: number, v: number): void {
    if (x >= 0 && x < W && y >= 0 && y < H) this.cells[y * W + x] = v
  }

  free(x: number, y: number): boolean {
    return this.get(x, y) === EMPTY
  }

  isEmpty(): boolean {
    return this.cells.every((c) => c === EMPTY)
  }

  clone(): Field {
    const f = new Field()
    f.cells.set(this.cells)
    return f
  }

  /** 浮いている粒を下に落とす。戻り値は動いた粒の [x, 元の y, 新しい y]（アニメーション用） */
  applyGravity(): [number, number, number][] {
    const moved: [number, number, number][] = []
    for (let x = 0; x < W; x++) {
      let write = 0
      for (let y = 0; y < H; y++) {
        const v = this.get(x, y)
        if (v === EMPTY) continue
        if (y !== write) {
          this.set(x, write, v)
          this.set(x, y, EMPTY)
          moved.push([x, y, write])
        }
        write++
      }
    }
    return moved
  }

  /** 消える粒のまとまり（見えている段だけ・4 個以上）と、巻き込まれて消えるおじゃま */
  findPops(): { groups: number[][]; garbage: number[] } {
    const seen = new Uint8Array(W * H)
    const groups: number[][] = []
    for (let y = 0; y < VISIBLE_H; y++) {
      for (let x = 0; x < W; x++) {
        const c = this.get(x, y)
        const i = y * W + x
        if (c < 1 || c > COLORS || seen[i]) continue
        const group: number[] = []
        const stack = [i]
        seen[i] = 1
        while (stack.length) {
          const j = stack.pop()!
          group.push(j)
          const jx = j % W
          const jy = Math.floor(j / W)
          for (const [nx, ny] of [[jx + 1, jy], [jx - 1, jy], [jx, jy + 1], [jx, jy - 1]]) {
            if (nx < 0 || nx >= W || ny < 0 || ny >= VISIBLE_H) continue
            const k = ny * W + nx
            if (!seen[k] && this.cells[k] === c) {
              seen[k] = 1
              stack.push(k)
            }
          }
        }
        if (group.length >= POP_COUNT) groups.push(group)
      }
    }
    const garbage = new Set<number>()
    for (const g of groups) {
      for (const j of g) {
        const jx = j % W
        const jy = Math.floor(j / W)
        for (const [nx, ny] of [[jx + 1, jy], [jx - 1, jy], [jx, jy + 1], [jx, jy - 1]]) {
          if (nx >= 0 && nx < W && ny >= 0 && ny < VISIBLE_H && this.get(nx, ny) === GARBAGE) garbage.add(ny * W + nx)
        }
      }
    }
    return { groups, garbage: [...garbage] }
  }
}

/** 1 回の消去（連鎖の 1 段）の得点。chain は 1 から */
export function chainScore(groups: number[][], colorsOf: (g: number[]) => number, chain: number): number {
  const popped = groups.reduce((a, g) => a + g.length, 0)
  const colors = new Set(groups.map(colorsOf)).size
  const bonus = CHAIN_POWER[Math.min(chain - 1, CHAIN_POWER.length - 1)]
    + COLOR_BONUS[Math.min(colors, COLOR_BONUS.length - 1)]
    + groups.reduce((a, g) => a + GROUP_BONUS(g.length), 0)
  return 10 * popped * Math.min(999, Math.max(1, bonus))
}

// --- 乱数（seed が同じなら同じ順番。対戦では両者同じ組ぷよが来る） ---------------------------
export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
}
