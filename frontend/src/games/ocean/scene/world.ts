// 空・太陽・星・光。カメラについてまわる大きな球に空の色を塗る（レースと同じやり方）。
//
// 水中にカメラがあるときは、空の球ごと水の霧の色にしてしまう（OceanScene.ts）。
// そうしないと、海面の板の外側や透けた部分から空が見えてしまう。

import * as THREE from 'three'

export interface World {
  group: THREE.Group
  /** 空の色（top / bottom を毎フレーム書き換える） */
  sky: { top: { value: THREE.Color }; bottom: { value: THREE.Color } }
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  /** 太陽の絵（空の球に貼りついた明るい円） */
  sunDisc: THREE.Mesh
  /** 星（夜だけ見える。material.opacity で出し入れ） */
  stars: THREE.Points
  dispose(): void
}

export function buildWorld(): World {
  const group = new THREE.Group()
  const disposables: { dispose(): void }[] = []

  const skyGeo = new THREE.SphereGeometry(900, 24, 16)
  const sky = { top: { value: new THREE.Color(0x2f7fd8) }, bottom: { value: new THREE.Color(0xbfe6f5) } }
  const skyMat = new THREE.ShaderMaterial({
    uniforms: sky,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: `
uniform vec3 top, bottom;
varying vec3 vPos;
void main() {
  float h = normalize(vPos).y;
  // 地平線のすぐ上は明るく、真上へ向かって濃くなる
  float t = pow(smoothstep(-0.05, 0.6, h), 0.7);
  gl_FragColor = vec4(mix(bottom, top, t), 1.0);
}`,
  })
  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  skyMesh.renderOrder = -10
  skyMesh.frustumCulled = false
  group.add(skyMesh)
  disposables.push(skyGeo, skyMat)

  // 太陽の円盤（空の球の内側に置く）
  const discGeo = new THREE.CircleGeometry(38, 32)
  const discMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc, fog: false, transparent: true, opacity: 0.95 })
  const sunDisc = new THREE.Mesh(discGeo, discMat)
  sunDisc.renderOrder = -9
  group.add(sunDisc)
  disposables.push(discGeo, discMat)

  // 星
  const starCount = 700
  const starPos = new Float32Array(starCount * 3)
  for (let i = 0; i < starCount; i++) {
    const u = Math.random(), v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(1 - v) * 0.5 // 上半分だけ
    const r = 850
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi)
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 3.2, sizeAttenuation: false, fog: false,
                                            transparent: true, opacity: 0, depthWrite: false })
  const stars = new THREE.Points(starGeo, starMat)
  stars.renderOrder = -9
  stars.frustumCulled = false
  group.add(stars)
  disposables.push(starGeo, starMat)

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.6)
  sun.position.set(50, 100, 35)
  group.add(sun, sun.target)
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x0b3f5a, 1.1)
  group.add(hemi)

  return {
    group, sky, sun, hemi, sunDisc, stars,
    dispose: () => { for (const d of disposables) d.dispose() },
  }
}
