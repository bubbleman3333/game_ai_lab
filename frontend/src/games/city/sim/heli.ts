// 警察のヘリコプター。手配度 ★3 以上で飛んできて、上空から追いかける。
//   ★3  サーチライトで照らしながら追う（近くにいるあいだは「見られている」扱い）
//   ★4+ 狙撃手が上から撃ってくる。速く走っているほど当たりにくい
// ヘリは車より遅い（最高 30m/s）ので、全力で走れば振り切れる。three.js には依存しない。

import type { Body } from './vehicle'
import { speedOf } from './vehicle'

export const HELI_ALT = 38
const MAX_SPEED = 30
const ACCEL = 9

export interface Shot {
  /** 撃った位置（ヘリの横の扉） */
  fx: number; fy: number; fz: number
  /** 弾が届いた位置 */
  tx: number; tz: number
  hit: boolean
}

export class Heli {
  x: number
  y = HELI_ALT
  z: number
  yaw = 0
  vx = 0
  vz = 0
  /** 機体の傾き（進む向きへ前のめりになる。見た目用） */
  pitch = 0
  roll = 0
  /** 回っている角度（見た目用） */
  rotor = 0
  private orbit = Math.random() * Math.PI * 2
  private cooldown = 3
  private burst = 0
  private burstGap = 0
  leaving = false

  constructor(x: number, z: number) {
    this.x = x
    this.z = z
  }

  /** 相手の少し先の上空を、ゆっくり旋回しながら追う。撃った弾を返す */
  update(dt: number, target: Body, shooting: boolean, rng: () => number): Shot[] {
    this.orbit += dt * 0.35
    let gx: number, gz: number
    if (this.leaving) {
      // 手配が下がったら、遠くへ飛び去る
      const a = Math.atan2(this.x - target.x, this.z - target.z)
      gx = this.x + Math.sin(a) * 200
      gz = this.z + Math.cos(a) * 200
    } else {
      gx = target.x + target.vx * 1.5 + Math.sin(this.orbit) * 22
      gz = target.z + target.vz * 1.5 + Math.cos(this.orbit) * 22
    }
    // 目標へ向かう速さを決め、急には変えない（ヘリは重い）
    const dx = gx - this.x, dz = gz - this.z
    const d = Math.hypot(dx, dz) || 1
    const want = Math.min(MAX_SPEED, d * 0.6)
    const wx = (dx / d) * want, wz = (dz / d) * want
    const ax = Math.max(-ACCEL, Math.min(ACCEL, (wx - this.vx) * 1.5))
    const az = Math.max(-ACCEL, Math.min(ACCEL, (wz - this.vz) * 1.5))
    this.vx += ax * dt
    this.vz += az * dt
    this.x += this.vx * dt
    this.z += this.vz * dt
    this.y += ((this.leaving ? 80 : HELI_ALT) - this.y) * dt * 0.5
    // 機首は相手のほうへ
    const face = Math.atan2(target.x - this.x, target.z - this.z)
    let dyaw = face - this.yaw
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
    this.yaw += dyaw * Math.min(1, dt * 1.2)
    // 加速の向きに傾く
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const aLong = ax * fx + az * fz
    const aLat = ax * -fz + az * fx
    this.pitch += (aLong * 0.03 - this.pitch) * Math.min(1, dt * 3)
    this.roll += (aLat * 0.03 - this.roll) * Math.min(1, dt * 3)
    this.rotor += dt * 40

    const shots: Shot[] = []
    if (!shooting || this.leaving || this.horizontalDistance(target) > 90) return shots
    this.cooldown -= dt
    if (this.burst > 0) {
      this.burstGap -= dt
      if (this.burstGap <= 0) {
        this.burst--
        this.burstGap = 0.12
        // 速いほど当たりにくい（止まっていればほぼ当たる）
        const sp = speedOf(target)
        const hit = rng() < Math.max(0.12, 0.75 - sp / 45)
        const miss = hit ? 0.8 : 3 + rng() * 5
        const a = rng() * Math.PI * 2
        shots.push({
          fx: this.x + Math.cos(this.yaw) * 1.2, fy: this.y - 1, fz: this.z - Math.sin(this.yaw) * 1.2,
          tx: target.x + Math.sin(a) * miss, tz: target.z + Math.cos(a) * miss, hit,
        })
      }
    } else if (this.cooldown <= 0) {
      this.burst = 4 + Math.floor(rng() * 4)
      this.cooldown = 2.5 + rng() * 2
    }
    return shots
  }

  horizontalDistance(b: Body): number {
    return Math.hypot(b.x - this.x, b.z - this.z)
  }
}
