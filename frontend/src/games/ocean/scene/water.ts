// 海面と海底。どちらも「泳ぐ人についてまわる大きな板」で、波や砂の凹凸はシェーダーで
// ワールド座標から計算する（板が動いても模様は動かない）。
//
// 波の高さは JS 側でも同じ式で計算できる（waveHeight）。泳ぐ人やサメの背びれを
// 波に合わせて上下させるのに使う。GLSL の式は WAVES から文字列で組み立てるので、両者は必ず一致する。

import * as THREE from 'three'

/** 波の成分: [向き x, 向き z, 高さ(m), 波長(m), 速さ] */
const WAVES: [number, number, number, number, number][] = [
  [1.0, 0.3, 0.22, 14, 1.1],
  [-0.4, 1.0, 0.16, 9, 1.5],
  [0.7, -0.7, 0.08, 4.5, 2.2],
  [0.2, 1.0, 0.05, 2.3, 3.0],
]

/** 場所 (x, z) と時刻 t の波の高さ（m） */
export function waveHeight(x: number, z: number, t: number): number {
  let h = 0
  for (const [dx, dz, amp, len, speed] of WAVES) {
    const k = (Math.PI * 2) / len
    h += amp * Math.sin((dx * x + dz * z) * k + t * speed)
  }
  return h
}

/** GLSL の波の式（高さと傾き）。JS 側の waveHeight と同じ式 */
function waveGlsl(): string {
  const lines = WAVES.map(([dx, dz, amp, len, speed]) => {
    const k = ((Math.PI * 2) / len).toFixed(5)
    return `  ph = (${dx.toFixed(2)} * p.x + ${dz.toFixed(2)} * p.z) * ${k} + t * ${speed.toFixed(2)};
  h += ${amp.toFixed(3)} * sin(ph);
  dx += ${amp.toFixed(3)} * ${k} * ${dx.toFixed(2)} * cos(ph);
  dz += ${amp.toFixed(3)} * ${k} * ${dz.toFixed(2)} * cos(ph);`
  })
  return `
float waveH(vec3 p, float t, out vec3 n) {
  float h = 0.0, dx = 0.0, dz = 0.0, ph;
${lines.join('\n')}
  n = normalize(vec3(-dx, 1.0, -dz));
  return h;
}`
}

export interface WaterUniforms {
  [name: string]: THREE.IUniform
  time: { value: number }
  deep: { value: THREE.Color }
  shallow: { value: THREE.Color }
  sky: { value: THREE.Color }
  sunDir: { value: THREE.Vector3 }
  sunColor: { value: THREE.Color }
  sunStrength: { value: number }
  fogColor: { value: THREE.Color }
  fogNear: { value: number }
  fogFar: { value: number }
}

export interface Water {
  mesh: THREE.Mesh
  uniforms: WaterUniforms
  dispose(): void
}

export function buildWater(size = 640, segments = 160): Water {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments)
  geo.rotateX(-Math.PI / 2)
  const uniforms: WaterUniforms = {
    time: { value: 0 },
    deep: { value: new THREE.Color(0x0b5f8a) },
    shallow: { value: new THREE.Color(0x37b7c9) },
    sky: { value: new THREE.Color(0xbfe6f5) },
    sunDir: { value: new THREE.Vector3(0.5, 1, 0.35).normalize() },
    sunColor: { value: new THREE.Color(0xfff2d8) },
    sunStrength: { value: 1 },
    fogColor: { value: new THREE.Color(0xbfe0ee) },
    fogNear: { value: 1 },
    fogFar: { value: 400 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    vertexShader: `
uniform float time;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
${waveGlsl()}
void main() {
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 n;
  float h = waveH(world, time, n);
  world.y += h;
  vWorld = world;
  vNormal = n;
  vHeight = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
    fragmentShader: `
uniform vec3 deep, shallow, sky, sunColor, fogColor;
uniform vec3 sunDir;
uniform float sunStrength, fogNear, fogFar, time;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
void main() {
  // 細かいさざ波: 頂点の波より細かい揺らぎを法線にだけ足す（きらめきが細かくなる）
  vec2 p = vWorld.xz;
  vec3 ripple = vec3(
    sin(p.x * 3.1 + time * 2.3) * cos(p.y * 2.7 - time * 1.9) + sin(p.x * 6.3 - time * 3.1) * 0.5,
    0.0,
    cos(p.x * 2.3 - time * 2.1) * sin(p.y * 3.3 + time * 2.6) + cos(p.y * 5.7 + time * 2.8) * 0.5);
  vec3 n = normalize(normalize(vNormal) + ripple * 0.06);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  vec3 color;
  float alpha;
  if (gl_FrontFacing) {
    // 上から見た海面: 斜めに見るほど空を映し、真上からは水の色。山の部分は少し明るい
    float fresnel = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float crest = smoothstep(-0.1, 0.35, vHeight);
    color = mix(deep, shallow, crest * 0.55);
    color = mix(color, sky, 0.15 + fresnel * 0.6);
    // 太陽のきらめき
    vec3 hv = normalize(sunDir + v);
    float spec = pow(max(dot(n, hv), 0.0), 240.0) * sunStrength;
    color += sunColor * spec * 1.6;
    // 細かいきらめき（波の小さな山）
    float sparkle = pow(max(dot(n, hv), 0.0), 40.0) * 0.12 * sunStrength;
    color += sunColor * sparkle;
    alpha = 0.78 + fresnel * 0.2;
  } else {
    // 下から見た海面: 明るい水色で、真上に近いほど空が透けて見える（スネルの窓）
    float up = max(dot(-v, vec3(0.0, -1.0, 0.0)), 0.0);
    color = mix(shallow * 1.25, sky, smoothstep(0.55, 1.0, up) * 0.7);
    // 波の山に光が集まる
    color += sunColor * smoothstep(0.0, 0.3, vHeight) * 0.25 * sunStrength;
    alpha = 0.92;
  }
  float f = smoothstep(fogNear, fogFar, dist);
  color = mix(color, fogColor, f);
  gl_FragColor = vec4(color, alpha);
}`,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 10 // ほかのものを描いたあとに重ねる（透けて見えるように）
  return { mesh, uniforms, dispose: () => { geo.dispose(); mat.dispose() } }
}

export interface FloorUniforms {
  [name: string]: THREE.IUniform
  time: { value: number }
  color: { value: THREE.Color }
  sunDir: { value: THREE.Vector3 }
  /** 光の揺らぎ（コースティクス）の強さ。深いところでは 0 */
  caustic: { value: number }
  fogColor: { value: THREE.Color }
  fogNear: { value: number }
  fogFar: { value: number }
}

export interface Floor {
  mesh: THREE.Mesh
  uniforms: FloorUniforms
  dispose(): void
}

/** 海底。砂のうねりと、海面から差し込む光の揺らぎ（コースティクス） */
export function buildFloor(size = 420, segments = 90): Floor {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments)
  geo.rotateX(-Math.PI / 2)
  const uniforms: FloorUniforms = {
    time: { value: 0 },
    color: { value: new THREE.Color(0xc9b98a) },
    sunDir: { value: new THREE.Vector3(0.5, 1, 0.35).normalize() },
    caustic: { value: 1 },
    fogColor: { value: new THREE.Color(0x1c7d9a) },
    fogNear: { value: 1 },
    fogFar: { value: 60 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
varying vec3 vWorld;
varying vec3 vNormal;
float bump(vec2 p, out vec2 g) {
  float h = 0.0;
  g = vec2(0.0);
  // 砂のうねり（大きい起伏 + 細かい波紋）
  float a = sin(p.x * 0.11 + p.y * 0.07), b = sin(p.x * 0.05 - p.y * 0.13);
  h += 1.6 * a + 1.2 * b;
  g += 1.6 * cos(p.x * 0.11 + p.y * 0.07) * vec2(0.11, 0.07) + 1.2 * cos(p.x * 0.05 - p.y * 0.13) * vec2(0.05, -0.13);
  float c = sin(p.x * 0.9 + p.y * 0.4);
  h += 0.12 * c;
  g += 0.12 * cos(p.x * 0.9 + p.y * 0.4) * vec2(0.9, 0.4);
  return h;
}
void main() {
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 g;
  world.y += bump(world.xz, g);
  vWorld = world;
  vNormal = normalize(vec3(-g.x, 1.0, -g.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
    fragmentShader: `
uniform float time, caustic, fogNear, fogFar;
uniform vec3 color, sunDir, fogColor;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  float light = 0.45 + 0.55 * max(dot(n, normalize(sunDir)), 0.0);
  // コースティクス: 動く 3 方向の波の干渉を細く光らせる
  vec2 p = vWorld.xz;
  float c1 = sin(p.x * 0.9 + time * 1.1) + sin(p.y * 0.8 - time * 0.9);
  float c2 = sin((p.x + p.y) * 0.6 + time * 0.7) + sin((p.x - p.y) * 0.7 - time * 1.3);
  float caus = pow(max(0.0, 1.0 - abs(c1 + c2) * 0.35), 4.0) * caustic;
  // 濃淡（砂の色むら）
  float mottle = 0.9 + 0.1 * sin(p.x * 0.23) * sin(p.y * 0.19);
  vec3 col = color * light * mottle + vec3(0.9, 0.95, 1.0) * caus * 0.3;
  float f = smoothstep(fogNear, fogFar, distance(cameraPosition, vWorld));
  gl_FragColor = vec4(mix(col, fogColor, f), 1.0);
}`,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  return { mesh, uniforms, dispose: () => { geo.dispose(); mat.dispose() } }
}

/** 海底の高さ（シェーダーの bump と同じ式）。岩やサンゴを海底に置くときに使う */
export function floorBump(x: number, z: number): number {
  return 1.6 * Math.sin(x * 0.11 + z * 0.07) + 1.2 * Math.sin(x * 0.05 - z * 0.13) + 0.12 * Math.sin(x * 0.9 + z * 0.4)
}
