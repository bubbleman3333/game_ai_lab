// たくさんの四角い面を 1 つの形（BufferGeometry）にまとめる道具。
//
// 建物を 1 棟ずつ Mesh にすると、600 棟で 600 回の描画命令になって重い。
// 同じ見た目（マテリアル）の面を全部 1 つの形に詰めれば、描画命令は 1 回で済む。
// そのかわり、面ごとに UV（テクスチャのどこを貼るか）を自分で計算して入れる。

import * as THREE from 'three'

export class GeoBuilder {
  private pos: number[] = []
  private nor: number[] = []
  private uv: number[] = []
  private idx: number[] = []

  get empty(): boolean { return this.idx.length === 0 }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.uv.push(u, v)
    return this.pos.length / 3 - 1
  }

  /**
   * 四角形。a → b → c → d は、面の表から見て左下・右下・右上・左上の順（反時計回り）。
   * n は面の向き（法線）。uv は同じ順で 4 点ぶん
   */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], uv: number[]): void {
    const i = this.vert(a[0], a[1], a[2], n[0], n[1], n[2], uv[0], uv[1])
    this.vert(b[0], b[1], b[2], n[0], n[1], n[2], uv[2], uv[3])
    this.vert(c[0], c[1], c[2], n[0], n[1], n[2], uv[4], uv[5])
    this.vert(d[0], d[1], d[2], n[0], n[1], n[2], uv[6], uv[7])
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3)
  }

  tri(a: number[], b: number[], c: number[], n: number[], uv: number[]): void {
    const i = this.vert(a[0], a[1], a[2], n[0], n[1], n[2], uv[0], uv[1])
    this.vert(b[0], b[1], b[2], n[0], n[1], n[2], uv[2], uv[3])
    this.vert(c[0], c[1], c[2], n[0], n[1], n[2], uv[4], uv[5])
    this.idx.push(i, i + 1, i + 2)
  }

  /**
   * 箱の 4 つの側面。外から見て正しい向きになるように並べる。
   * uv は「横の距離 ÷ su」「高さ ÷ sv」に u0, v0 を足したもの
   */
  walls(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number,
        su: number, sv: number, u0 = 0, v0 = 0): void {
    const faces: [number[], number[], number[]][] = [
      [[x1, z0], [x0, z0], [0, 0, -1]],
      [[x0, z1], [x1, z1], [0, 0, 1]],
      [[x1, z1], [x1, z0], [1, 0, 0]],
      [[x0, z0], [x0, z1], [-1, 0, 0]],
    ]
    let u = u0
    for (const [a, b, n] of faces) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const ua = u, ub = u + len / su
      const va = v0 + y0 / sv, vb = v0 + y1 / sv
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n, [ua, va, ub, va, ub, vb, ua, vb])
      u = ub
    }
  }

  /** 上向きの四角（屋根・地面）。uv は世界座標 ÷ s */
  top(x0: number, z0: number, x1: number, z1: number, y: number, s: number): void {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0],
              [x0 / s, z1 / s, x1 / s, z1 / s, x1 / s, z0 / s, x0 / s, z0 / s])
  }

  /** 箱（上面と側面。底は見えないので作らない） */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, s = 1): void {
    this.walls(x0, z0, x1, z1, y0, y1, s, s)
    this.top(x0, z0, x1, z1, y1, s)
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}
