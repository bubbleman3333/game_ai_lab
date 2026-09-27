// 泳ぐ人の見た目（クロールの動き）。当たり判定や動きの計算は sim/game.ts にあり、ここは絵だけ。
//
// 角ばって見えないように、胴体は回転体（Lathe。肩・胸・腰のくびれを持つ）、手足は先細りの筒に
// 関節の球をはさんで作る。体は +z を向いてうつ伏せ。
// 腕は肩を軸に x 軸まわりで一回転（前 → 下 → 後ろ → 上）させるとクロールの手のかきになる。
// 左右の腕は半周ずれている。脚は股を軸に上下（ばた足）。潜っているときは足を大きく振る。

import * as THREE from 'three'

const SKIN = 0xd9a07a
const SUIT = 0x17365f
const CAP = 0xd83a3a

export interface SwimmerPose {
  /** 前に進む速さ（m/s） */
  speed: number
  /** 力の入れ具合（0〜1。ダッシュで 1） */
  effort: number
  /** 上下の速さ（m/s。潜っていると負） */
  vy: number
  /** 動きが鈍っている（刺された直後） */
  stunned: boolean
  /** 蹴り（反撃）の残り時間（秒） */
  kick: number
  /** 頭が水の中か */
  underwater: boolean
}

export interface SwimmerModel {
  group: THREE.Group
  /** 頭の位置（泡を出す場所）。ワールド座標を書き込む */
  headWorld(target: THREE.Vector3): THREE.Vector3
  /** 手の位置（水しぶきの場所）。side は 0 = 左, 1 = 右 */
  handWorld(side: number, target: THREE.Vector3): THREE.Vector3
  /** 手が水面を叩いた瞬間なら true（水しぶき用。1 ストロークに 1 回） */
  update(dt: number, pose: SwimmerPose): boolean
  dispose(): void
}

/** 先細りの筒（手足の 1 節）。根元が原点で、+z 方向へ伸びる */
function limb(r0: number, r1: number, len: number, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r1, r0, len, 14, 1)
  geo.rotateX(Math.PI / 2)
  geo.translate(0, 0, len / 2)
  return new THREE.Mesh(geo, mat)
}

function ball(r: number, mat: THREE.Material, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat)
  m.scale.set(sx, sy, sz)
  return m
}

export function buildSwimmer(): SwimmerModel {
  const group = new THREE.Group()
  const body = new THREE.Group()
  group.add(body)
  // 水中で真っ黒にならないよう、肌はほんの少しだけ自分で光らせる
  const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.55, metalness: 0.02, emissive: 0x3a2418, emissiveIntensity: 0.35 })
  const suitMat = new THREE.MeshStandardMaterial({ color: SUIT, roughness: 0.5 })
  const capMat = new THREE.MeshStandardMaterial({ color: CAP, roughness: 0.35 })
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f1b33, roughness: 0.15, metalness: 0.4 })
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 })
  const disposables: { dispose(): void }[] = [skinMat, suitMat, capMat, glassMat, strapMat]
  const track = <T extends THREE.Mesh>(m: T) => { disposables.push(m.geometry); return m }

  // 胴体: 腰（z = -0.28）から首（z = +0.30）まで。肩が広く、腰がくびれた回転体
  const profile: [number, number][] = [
    [0.09, 0], [0.155, 0.05], [0.17, 0.12], [0.15, 0.24], [0.16, 0.34], [0.185, 0.44], [0.19, 0.5], [0.15, 0.55], [0.06, 0.58],
  ]
  const torsoGeo = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 22)
  torsoGeo.rotateX(Math.PI / 2) // y → z
  torsoGeo.translate(0, 0, -0.28)
  torsoGeo.computeVertexNormals()
  const torso = new THREE.Mesh(torsoGeo, skinMat)
  torso.scale.set(1.15, 0.72, 1)
  body.add(torso)
  disposables.push(torsoGeo)
  // 水着（腰まわりを少し太い回転体で覆う）
  const suitProfile: [number, number][] = [[0.1, -0.02], [0.165, 0.03], [0.178, 0.12], [0.16, 0.22], [0.15, 0.25]]
  const suitGeo = new THREE.LatheGeometry(suitProfile.map(([r, y]) => new THREE.Vector2(r, y)), 22)
  suitGeo.rotateX(Math.PI / 2)
  suitGeo.translate(0, 0, -0.29)
  suitGeo.computeVertexNormals()
  const suit = new THREE.Mesh(suitGeo, suitMat)
  suit.scale.set(1.16, 0.74, 1)
  body.add(suit)
  disposables.push(suitGeo)
  // 首
  const neck = track(limb(0.055, 0.06, 0.08, skinMat))
  neck.position.set(0, 0.03, 0.29)
  body.add(neck)

  // 頭: 少し縦長の球にスイムキャップとゴーグル
  const head = new THREE.Group()
  head.position.set(0, 0.05, 0.42)
  head.add(track(ball(0.125, skinMat, 0.92, 1.08, 1)))
  const cap = track(new THREE.Mesh(new THREE.SphereGeometry(0.133, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), capMat))
  cap.scale.set(0.93, 1.08, 1)
  cap.rotation.x = -0.45
  head.add(cap)
  for (const side of [-1, 1]) {
    const lens = track(ball(0.045, glassMat, 1, 0.75, 0.55))
    lens.position.set(side * 0.052, -0.005, 0.115)
    head.add(lens)
  }
  const strap = track(new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.008, 6, 24), strapMat))
  strap.rotation.x = Math.PI / 2 - 0.15
  strap.position.y = 0.0
  head.add(strap)
  // 耳
  for (const side of [-1, 1]) {
    const ear = track(ball(0.03, skinMat, 0.5, 1, 1))
    ear.position.set(side * 0.12, -0.01, 0.0)
    head.add(ear)
  }
  head.rotation.x = 0.35 // 少し顔を下げる（うつ伏せ）
  body.add(head)

  // 腕（肩を軸に回す）: 肩の球 → 上腕 → 肘の球 → 前腕 → 手
  const arms: THREE.Group[] = []
  const elbows: THREE.Group[] = []
  const hands: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group()
    shoulder.position.set(side * 0.2, 0.03, 0.2)
    shoulder.add(track(ball(0.062, skinMat)))
    shoulder.add(track(limb(0.055, 0.045, 0.27, skinMat)))
    const elbow = new THREE.Group()
    elbow.position.z = 0.27
    elbow.rotation.x = 0.35
    elbow.add(track(ball(0.046, skinMat)))
    elbow.add(track(limb(0.043, 0.035, 0.25, skinMat)))
    const hand = track(ball(0.055, skinMat, 1.1, 0.45, 1.5))
    hand.position.z = 0.29
    elbow.add(hand)
    shoulder.add(elbow)
    body.add(shoulder)
    arms.push(shoulder)
    elbows.push(elbow)
    hands.push(hand)
  }

  // 脚（股を軸に上下）: 股 → 太もも → 膝の球 → すね → 足
  const legs: THREE.Group[] = []
  const knees: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const hip = new THREE.Group()
    hip.position.set(side * 0.085, -0.01, -0.27)
    hip.rotation.y = Math.PI // 後ろへ伸ばす
    hip.add(track(ball(0.075, skinMat)))
    hip.add(track(limb(0.075, 0.058, 0.36, skinMat)))
    const knee = new THREE.Group()
    knee.position.z = 0.36
    knee.add(track(ball(0.058, skinMat)))
    knee.add(track(limb(0.055, 0.04, 0.34, skinMat)))
    const ankle = track(ball(0.042, skinMat))
    ankle.position.z = 0.34
    knee.add(ankle)
    const foot = track(ball(0.05, skinMat, 0.9, 0.42, 2.2))
    foot.position.set(0, 0.035, 0.36)
    foot.rotation.x = -0.35
    knee.add(foot)
    hip.add(knee)
    body.add(hip)
    legs.push(hip)
    knees.push(knee)
  }

  let strokePhase = 0
  let kickPhase = 0
  let lastSplashCycle = -1

  return {
    group,
    headWorld(target) {
      return head.getWorldPosition(target)
    },
    handWorld(side, target) {
      return hands[side].getWorldPosition(target)
    },
    update(dt, pose) {
      const rate = pose.stunned ? 0.6 : 1.3 + pose.effort * 1.1 // 1 秒に何回かく
      strokePhase += rate * Math.PI * 2 * dt
      kickPhase += (pose.stunned ? 3 : 5.5 + pose.effort * 5) * dt

      // 腕: 左右で半周ずらす。蹴り（反撃）のあいだは両腕を前に突き出す
      for (let i = 0; i < 2; i++) {
        const sign = i === 0 ? 1 : -1
        if (pose.kick > 0) {
          arms[i].rotation.x = THREE.MathUtils.damp(arms[i].rotation.x % (Math.PI * 2), -0.15, 20, dt)
          arms[i].rotation.z = sign * 0.15
          elbows[i].rotation.x = THREE.MathUtils.damp(elbows[i].rotation.x, 0.1, 20, dt)
          continue
        }
        const cyc = strokePhase + i * Math.PI
        arms[i].rotation.x = cyc
        const c = ((cyc % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const recovering = c > Math.PI // 水の上で戻しているあいだ
        // 水の中では腕を伸ばして深くかき、戻すときは肘を高く曲げて外へ開く
        elbows[i].rotation.x = THREE.MathUtils.damp(elbows[i].rotation.x, recovering ? 1.45 : 0.3, 14, dt)
        arms[i].rotation.z = sign * (recovering ? 0.45 : -0.08)
      }
      // 脚: ばた足。潜っているときは大きく、蹴りのときは両脚をそろえて振る
      const amp = pose.underwater ? 0.42 : 0.28
      for (let i = 0; i < 2; i++) {
        const k = pose.kick > 0 ? Math.sin(pose.kick * 14) * 0.9 : Math.sin(kickPhase + i * Math.PI) * amp
        legs[i].rotation.x = -k
        knees[i].rotation.x = Math.max(0, k) * 0.9 + 0.08
      }
      // 体のひねり（かきに合わせて左右にロール）と、潜るときの前傾
      body.rotation.z = Math.sin(strokePhase) * 0.3
      const pitch = Math.atan2(-pose.vy, Math.max(pose.speed, 1.5))
      body.rotation.x = THREE.MathUtils.damp(body.rotation.x, pitch, 6, dt)
      // 顔: 海面では下を向き、かきに合わせて息継ぎで横を向く。潜っているときは前を見る
      const breath = pose.underwater ? 0 : Math.max(0, Math.sin(strokePhase)) * 0.9
      head.rotation.x = THREE.MathUtils.damp(head.rotation.x, pose.underwater ? -0.25 : 0.35 - breath * 0.2, 6, dt)
      head.rotation.z = THREE.MathUtils.damp(head.rotation.z, breath, 8, dt)

      // 手が入水した瞬間（角度が 0 を通過）を 1 回だけ知らせる
      const cycle = Math.floor(strokePhase / Math.PI) // 半周ごと（左右どちらかの手）
      if (cycle !== lastSplashCycle) {
        lastSplashCycle = cycle
        return !pose.underwater
      }
      return false
    },
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}
