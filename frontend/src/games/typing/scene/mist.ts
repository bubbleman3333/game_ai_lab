// 地面を這う霧。大きな板を地面すれすれに寝かせ、ノイズのまだら模様をゆっくり流す。
// 歩くと模様が手前へ流れる（offset を進める）ので、前へ進んでいる感じも出る。
// 2 枚を高さと速さを変えて重ね、厚みを出している。

import * as THREE from 'three'

const VERT = /* glsl */ `
  varying vec2 vWorld;
  varying float vDepth;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xz;
    vec4 mv = viewMatrix * world;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOffset;
  uniform float uAmount;
  uniform vec3 uColor;
  varying vec2 vWorld;
  varying float vDepth;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 p = vec2(vWorld.x, vWorld.y + uOffset) * 0.08;
    float n = fbm(p + vec2(uTime * 0.03, uTime * 0.01));
    float m = smoothstep(0.35, 0.85, n);
    // カメラのすぐ近くと遠くは薄く（板の端が見えないように）
    float fade = smoothstep(1.5, 6.0, vDepth) * (1.0 - smoothstep(35.0, 60.0, vDepth));
    gl_FragColor = vec4(uColor, m * fade * uAmount);
  }
`

export class Mist {
  readonly group = new THREE.Group()
  private layers: { mat: THREE.ShaderMaterial; speed: number }[] = []
  private offset = 0

  constructor(color: THREE.ColorRepresentation, amount: number) {
    const c = new THREE.Color(color)
    for (const [y, speed, a] of [[0.25, 1, 1], [0.8, 0.7, 0.6]]) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
        uniforms: { uTime: { value: Math.random() * 100 }, uOffset: { value: 0 }, uAmount: { value: amount * a }, uColor: { value: c } },
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(90, 80), mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.position.set(0, y, 36)
      this.group.add(mesh)
      this.layers.push({ mat, speed })
    }
  }

  update(dt: number, walked: number): void {
    this.offset += walked
    for (const l of this.layers) {
      l.mat.uniforms.uTime.value += dt * l.speed
      l.mat.uniforms.uOffset.value = this.offset * l.speed
    }
  }
}
