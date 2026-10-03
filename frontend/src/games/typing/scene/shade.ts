// 影の見た目（シェーダー）。四角い板 1 枚に、ゆらめくもやの体と光る目を描く。
//
// 体の形は「距離」で決めている（d < 0 が体の中）。基本は「まる影」: 頭は円、胴は下へ広がり、すそは波打つ触手。
// 形ごとに、角・耳・腕・根などを足したり、体そのものを別の形（からかさ・提灯・壁・へび…）に差し替えたりする。
// そこにノイズ（fbm）を足して輪郭をもやもやさせ、時間で流す。
// 目はまばたきし、狙われると赤くなる。目の明るさは 1 を超えるので、ブルーム（光のにじみ）で光って見える。
//
// 形の種類（uShape）。SHAPES の番号と同じ。ふつうの影は 15 種類:
//    0 まる影        1 鬼影（角）        2 一つ目          3 猫影（耳・小さい）  4 のっぽ（長い腕）
//   20 からかさ（跳ねる）21 提灯おばけ（光る） 22 ぬりかべ        23 ろくろ首          24 こだま（白い・穴の目）
//   25 烏天狗（くちばし・翼）26 くらげ影（光る）27 双子影        28 狐面             29 大蛇
//   30 地の手（足もとから生える手。手のひらに目）
// ボス: 10 根っこ / 11 霧の主 / 12 忘れ神（角と白い面）/ 13 月を呑む影（三日月の口）/ 14 夜の主
//
// 色は「あらかじめ透明度を掛けた色」で出し、ブレンドも合わせている（輪郭の光を自然に重ねるため）。

import * as THREE from 'three'

export const SHAPES = {
  round: 0, oni: 1, oneEye: 2, cat: 3, tall: 4,
  umbrella: 20, lantern: 21, wall: 22, longNeck: 23, kodama: 24,
  tengu: 25, jelly: 26, twins: 27, foxMask: 28, serpent: 29, hand: 30,
  roots: 10, mist: 11, god: 12, moon: 13, lord: 14,
} as const
export type ShapeName = keyof typeof SHAPES

/** ふつうの影の 15 種類（ボスを除く） */
export const NORMAL_SHAPES: ShapeName[] = [
  'round', 'oni', 'oneEye', 'cat', 'tall', 'umbrella', 'lantern', 'wall', 'longNeck', 'kodama',
  'tengu', 'jelly', 'twins', 'foxMask', 'serpent',
]

/** 形ごとの目の色 */
const EYE_COLORS: Record<ShapeName, number> = {
  round: 0xffe2a0, oni: 0xff7a3a, oneEye: 0x8ff0ff, cat: 0xb8ff6a, tall: 0xe6d0ff,
  umbrella: 0xffd040, lantern: 0xfff0b0, wall: 0xffa060, longNeck: 0xff90c0, kodama: 0xc8ffc8,
  tengu: 0xffb030, jelly: 0x9fe8ff, twins: 0xffc8ff, foxMask: 0xff4040, serpent: 0xd8ff40, hand: 0xff5a5a,
  roots: 0xffb050, mist: 0xbff6ff, god: 0xff3030, moon: 0xffe8a0, lord: 0xff3a2a,
}

/** 大きさ（ふつうの影は 2.3m 四方の板に描く。それに掛ける） */
export const SHAPE_SCALE: Partial<Record<ShapeName, number>> = {
  tall: 1.22, wall: 1.3, longNeck: 1.25, serpent: 1.2, cat: 0.9, kodama: 0.85, jelly: 1.05, mist: 1.18, hand: 0.9,
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uLock;
  uniform float uFlash;
  uniform float uShape;
  uniform float uFogDensity;
  uniform float uOpacity;
  uniform vec3 uEye;
  uniform vec3 uAura;
  uniform vec3 uFogColor;
  varying vec2 vUv;
  varying float vDepth;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  // 太さが ra → rb と変わる線分（角・耳・腕・根）
  float seg(vec2 p, vec2 a, vec2 b, float ra, float rb) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - mix(ra, rb, h);
  }
  // 楕円の目（1 が中心、外は 0）
  float eye(vec2 p, vec2 c, float w, float h) {
    return smoothstep(1.0, 0.45, length((p - c) / vec2(w, h)));
  }
  // 三日月の口（中心 c、半径 r、開き具合 o）
  float grin(vec2 p, vec2 c, float r, float o) {
    float outer = length(p - c) - r;
    float inner = length(p - c - vec2(0.0, o)) - r;
    return smoothstep(0.015, -0.015, max(outer, -inner)) * step(p.y, c.y);
  }
  bool is(float s) { return abs(uShape - s) < 0.5; }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float t = uTime + uSeed * 10.0;

    // 形ごとの下ごしらえ（猫影は小さく、のっぽは細く、霧の主は横に広い）
    if (is(3.0)) p *= 1.3;
    if (is(4.0)) p.x *= 1.45;
    if (is(11.0)) p.x *= 0.72;

    // ---- 基本の体（まる影）----
    float headR = is(2.0) ? 0.42 : 0.36;
    float head = length((p - vec2(0.0, 0.28)) * vec2(1.0, 1.1)) - headR;
    float y = p.y;
    float sway = sin(y * 4.0 + t * 1.3) * 0.06;
    float halfW = (0.34 + (0.28 - y) * 0.2) * (is(27.0) ? 0.85 : 1.0);
    float hem = is(10.0) ? -0.95 : -0.72;
    float bottom = hem + sin(p.x * 9.0 + t * 2.0) * 0.09 + sin(p.x * 17.0 - t * 3.1) * 0.04
                 + fbm(vec2(p.x * 3.0, t * 0.5)) * 0.25;
    float body = max(abs(p.x + sway) - halfW, max(y - 0.28, bottom - y));
    float d = min(head, body);

    // 目の置き方（mode 0: ふたつ / 1: ひとつ / 2: 無し（穴）/ 3: よっつ / 4: 切れ長）
    float eyeMode = 0.0;
    vec2 eL = vec2(-0.14, 0.3), eR = vec2(0.14, 0.3);
    float ew = 0.085, ehMul = 1.0;
    // 体の色（ほとんど黒。光る体の形だけ差し替える）
    vec3 col = vec3(0.012, 0.008, 0.03) + uAura * 0.22 * fbm(p * 5.0 + t * 0.3);
    float mouth = 0.0;

    // ---- 角・冠・耳・腕・根（まる影に足す）----
    if (is(1.0) || is(12.0) || is(14.0)) {
      float len = is(1.0) ? 0.92 : 1.0;
      d = min(d, seg(p, vec2(-0.2, 0.52), vec2(-0.36, len), 0.08, 0.0));
      d = min(d, seg(p, vec2(0.2, 0.52), vec2(0.36, len), 0.08, 0.0));
    }
    if (is(14.0)) {
      d = min(d, seg(p, vec2(0.0, 0.6), vec2(0.0, 0.98), 0.07, 0.0));
      d = min(d, seg(p, vec2(-0.1, 0.6), vec2(-0.16, 0.86), 0.05, 0.0));
      d = min(d, seg(p, vec2(0.1, 0.6), vec2(0.16, 0.86), 0.05, 0.0));
    }
    if (is(3.0)) {
      d = min(d, seg(p, vec2(-0.2, 0.5), vec2(-0.3, 0.8), 0.1, 0.0));
      d = min(d, seg(p, vec2(0.2, 0.5), vec2(0.3, 0.8), 0.1, 0.0));
      eL.y = eR.y = 0.27; ew = 0.075;
    }
    if (is(4.0)) {
      float sw = sin(t * 1.7) * 0.12;
      d = min(d, seg(p, vec2(-0.28, 0.1), vec2(-0.62 + sw, -0.75), 0.07, 0.02));
      d = min(d, seg(p, vec2(0.28, 0.1), vec2(0.62 + sw, -0.75), 0.07, 0.02));
    }
    if (is(10.0)) {
      for (int i = 0; i < 5; i++) {
        float k = float(i) / 4.0 * 2.0 - 1.0;
        d = min(d, seg(p, vec2(k * 0.3, -0.2), vec2(k * 0.95 + sin(t * 1.3 + float(i)) * 0.06, -0.98), 0.07, 0.015));
      }
    }
    if (is(2.0)) eyeMode = 1.0;
    if (is(12.0)) eyeMode = 4.0;

    // ---- 体ごと差し替える形 ----
    if (is(20.0)) {
      // からかさ: 三角の傘に一本足。ぴょんぴょん跳ねる。一つ目と大きな口
      float b = abs(sin(t * 3.0)) * 0.14;
      vec2 q = p - vec2(0.0, b);
      float canopy = max(abs(q.x) - (0.82 - q.y) * 0.78, max(0.02 - q.y, q.y - 0.82));
      d = min(canopy, seg(q, vec2(0.0, 0.05), vec2(0.0, -0.78), 0.055, 0.045));
      // 傘の骨の筋
      col += uAura * 0.18 * smoothstep(0.02, 0.0, abs(fract(atan(q.x, 0.9 - q.y) * 3.0) - 0.5) - 0.45);
      eyeMode = 1.0; eL = vec2(0.0, 0.42 + b); ew = 0.1;
      mouth = grin(p, vec2(0.0, 0.26 + b), 0.13, 0.06);
    } else if (is(21.0)) {
      // 提灯おばけ: 体そのものが橙に光る。横の骨の筋、一つ目、裂けた口
      d = (length((p - vec2(0.0, 0.05)) / vec2(0.44, 0.62)) - 1.0) * 0.45;
      d = min(d, seg(p, vec2(-0.22, 0.66), vec2(0.22, 0.66), 0.05, 0.05));
      d = min(d, seg(p, vec2(-0.2, -0.56), vec2(0.2, -0.56), 0.05, 0.05));
      float ribs = 0.55 + 0.45 * smoothstep(0.6, 1.0, cos(p.y * 30.0));
      col = vec3(0.9, 0.38, 0.08) * (0.28 + 0.22 * ribs) * (0.85 + 0.15 * sin(t * 6.0));
      eyeMode = 1.0; eL = vec2(0.1, 0.22); ew = 0.1;
      mouth = grin(p, vec2(-0.02, 0.02), 0.2, 0.08);
    } else if (is(22.0)) {
      // ぬりかべ: 大きな壁。石垣の模様、小さな目
      vec2 q = abs(p - vec2(0.0, -0.08)) - vec2(0.62, 0.74);
      d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.06;
      vec2 brick = vec2(p.x * 3.0 + step(1.0, mod(floor(p.y * 5.0), 2.0)) * 0.5, p.y * 5.0);
      // 石の継ぎ目（マス目の端に近いほど 1）
      float joint = smoothstep(0.4, 0.5, max(abs(fract(brick.x) - 0.5), abs(fract(brick.y) - 0.5)));
      col = mix(vec3(0.05, 0.045, 0.06), vec3(0.015, 0.012, 0.02), joint) + uAura * 0.1 * fbm(p * 4.0);
      eL = vec2(-0.22, 0.24); eR = vec2(0.22, 0.24); ew = 0.06;
    } else if (is(23.0)) {
      // ろくろ首: 低い体から首がのびて、頭がゆらゆら
      vec2 h = vec2(sin(t * 0.9) * 0.32, 0.6 + sin(t * 1.3) * 0.06);
      float lowBody = max(abs(p.x + sway) - (0.3 + (-0.1 - y) * 0.2), max(y + 0.1, bottom - y));
      float neck = seg(p, vec2(0.0, -0.12), h, 0.06, 0.045);
      float hd = length(p - h) - 0.19;
      d = min(min(lowBody, neck), hd);
      eL = h + vec2(-0.07, 0.02); eR = h + vec2(0.07, 0.02); ew = 0.05;
    } else if (is(24.0)) {
      // こだま: 白くて丸い。目と口は暗い穴
      d = min(length((p - vec2(0.0, 0.12)) * vec2(1.0, 0.95)) - 0.36, seg(p, vec2(0.0, -0.1), vec2(0.0, -0.62), 0.22, 0.16));
      col = vec3(0.32, 0.4, 0.3) * (0.8 + 0.2 * fbm(p * 3.0 + t * 0.2));
      float holes = eye(p, vec2(-0.12, 0.18), 0.07, 0.1) + eye(p, vec2(0.12, 0.18), 0.07, 0.1)
                  + eye(p, vec2(0.0, -0.02), 0.06 + 0.02 * sin(t * 2.0), 0.08);
      col *= 1.0 - clamp(holes, 0.0, 1.0) * 0.95;
      eyeMode = 2.0;
    } else if (is(25.0)) {
      // 烏天狗: くちばしと、はばたく翼
      float flap = sin(t * 4.0) * 0.18;
      d = min(d, seg(p, vec2(0.0, 0.24), vec2(0.0, 0.02), 0.075, 0.0));
      d = min(d, seg(p, vec2(-0.28, 0.05), vec2(-0.9, 0.42 + flap), 0.13, 0.02));
      d = min(d, seg(p, vec2(0.28, 0.05), vec2(0.9, 0.42 + flap), 0.13, 0.02));
      eL = vec2(-0.13, 0.34); eR = vec2(0.13, 0.34); ew = 0.07; ehMul = 0.8;
    } else if (is(26.0)) {
      // くらげ影: 青白く光る傘と、ゆれる触手
      float dome = max(length((p - vec2(0.0, 0.12)) / vec2(0.52, 0.45)) - 1.0, (0.08 - p.y) * 2.0) * 0.45;
      d = dome;
      for (int i = 0; i < 5; i++) {
        float k = float(i) / 4.0 * 2.0 - 1.0;
        d = min(d, seg(p, vec2(k * 0.36, 0.12), vec2(k * 0.42 + sin(t * 2.0 + float(i) * 1.3) * 0.14, -0.9), 0.045, 0.012));
      }
      col = vec3(0.1, 0.28, 0.55) * (0.45 + 0.35 * fbm(p * 4.0 + t * 0.4));
      eL = vec2(-0.12, 0.32); eR = vec2(0.12, 0.32); ew = 0.06;
    } else if (is(27.0)) {
      // 双子影: 頭がふたつ、目がよっつ
      float h2 = min(length(p - vec2(-0.24, 0.32)) - 0.22, length(p - vec2(0.24, 0.32 + sin(t * 2.0) * 0.03)) - 0.22);
      d = min(body, h2);
      eyeMode = 3.0;
    } else if (is(28.0)) {
      // 狐面: 白い狐のお面をかぶった影
      float m = smoothstep(0.02, -0.02, min(length((p - vec2(0.0, 0.28)) * vec2(1.0, 0.85)) - 0.26,
                 min(seg(p, vec2(-0.13, 0.46), vec2(-0.24, 0.7), 0.07, 0.0), seg(p, vec2(0.13, 0.46), vec2(0.24, 0.7), 0.07, 0.0))));
      d = min(d, min(seg(p, vec2(-0.13, 0.46), vec2(-0.24, 0.7), 0.07, 0.0), seg(p, vec2(0.13, 0.46), vec2(0.24, 0.7), 0.07, 0.0)));
      float red = smoothstep(0.03, 0.0, abs(length(p - vec2(0.0, 0.5)) - 0.12)) * step(0.45, p.y)
                + smoothstep(0.025, 0.0, abs(p.y - 0.2 - abs(p.x) * 0.5)) * step(abs(p.x), 0.18);
      col = mix(col, mix(vec3(0.5, 0.48, 0.44), vec3(0.6, 0.03, 0.03), clamp(red, 0.0, 1.0)), m);
      eyeMode = 4.0;
    } else if (is(30.0)) {
      // 地の手: 手首から先が地面から生え、指がわさわさ動く。手のひらに目がひとつ
      float palm = length((p - vec2(0.0, -0.3)) * vec2(1.0, 0.9)) - 0.28;
      d = min(palm, seg(p, vec2(0.0, -0.4), vec2(0.0, -1.0), 0.2, 0.22));
      for (int i = 0; i < 4; i++) {
        float k = float(i) / 3.0 * 2.0 - 1.0;
        vec2 base = vec2(k * 0.2, -0.12);
        vec2 tip = base + vec2(k * 0.12 + sin(t * 3.0 + float(i)) * 0.06, 0.55 - abs(k) * 0.12);
        d = min(d, seg(p, base, tip, 0.07, 0.035));
      }
      d = min(d, seg(p, vec2(-0.26, -0.3), vec2(-0.55, 0.0 + sin(t * 2.5) * 0.05), 0.07, 0.04)); // 親指
      eyeMode = 1.0; eL = vec2(0.0, -0.3); ew = 0.12;
    } else if (is(29.0)) {
      // 大蛇: うねる胴が、下から頭へ
      d = 1e3;
      vec2 c = vec2(0.0);
      for (int i = 0; i < 10; i++) {
        float yy = -0.85 + float(i) * 0.15;
        c = vec2(sin(yy * 3.5 + t * 1.5) * 0.3, yy);
        d = min(d, length(p - c) - (0.17 - float(i) * 0.006));
      }
      vec2 h = c + vec2(0.0, 0.14);
      d = min(d, length((p - h) * vec2(0.85, 1.1)) - 0.17);
      // 二股の舌
      float tongue = seg(p, h + vec2(0.0, -0.12), h + vec2(0.0, -0.3), 0.012, 0.008);
      mouth = smoothstep(0.01, -0.01, tongue) * step(0.5, fract(t * 0.8));
      eL = h + vec2(-0.08, 0.03); eR = h + vec2(0.08, 0.03); ew = 0.05; ehMul = 0.7;
    }

    d += (fbm(p * 3.5 + vec2(0.0, -t * 0.8)) - 0.5) * (is(11.0) ? 0.38 : (is(22.0) || is(21.0)) ? 0.08 : 0.2);
    float alpha = smoothstep(0.05, -0.07, d);

    // 忘れ神の白い面
    if (is(12.0)) {
      float mask = smoothstep(0.02, -0.02, length((p - vec2(0.0, 0.3)) * vec2(1.0, 0.85)) - 0.26) * alpha;
      col = mix(col, vec3(0.42, 0.4, 0.36), mask);
      float stripe = smoothstep(0.03, 0.0, abs(p.y - 0.18 + abs(p.x) * 0.3)) * step(abs(p.x), 0.2);
      col = mix(col, vec3(0.5, 0.02, 0.02), stripe * mask);
    }

    // 輪郭のもや（狙われると赤みがかる）
    float aura = exp(-max(d, 0.0) * 8.0) * (1.0 - alpha);
    vec3 auraCol = mix(uAura, vec3(1.0, 0.3, 0.15), uLock);

    // 目（ときどきまばたき）
    float open = smoothstep(0.0, 0.05, abs(fract(t * 0.21 + uSeed) - 0.5) - 0.02);
    float eh = mix(0.012, 0.065, open) * ehMul;
    float eyes = 0.0;
    if (eyeMode < 0.5) {
      eyes = eye(p, eL, ew, eh) + eye(p, eR, ew, eh);
    } else if (eyeMode < 1.5) {
      float big = eye(p, eL.x == -0.14 ? vec2(0.0, 0.3) : eL, max(ew, 0.17) * (is(2.0) ? 1.0 : 0.7), eh * 1.9);
      float pupil = eye(p, (eL.x == -0.14 ? vec2(0.0, 0.3) : eL) + vec2(sin(t * 0.7) * 0.04, 0.0), 0.035, eh * 1.6);
      eyes = big * (1.0 - pupil * 0.95);
    } else if (eyeMode < 3.5 && eyeMode > 2.5) {
      eyes = eye(p, vec2(-0.31, 0.34), 0.05, eh * 0.8) + eye(p, vec2(-0.17, 0.34), 0.05, eh * 0.8)
           + eye(p, vec2(0.17, 0.34), 0.05, eh * 0.8) + eye(p, vec2(0.31, 0.34), 0.05, eh * 0.8);
    } else if (eyeMode > 3.5) {
      eyes = eye(p, vec2(-0.11, 0.32), 0.08, eh * 0.4) + eye(p, vec2(0.11, 0.32), 0.08, eh * 0.4);
    }
    if (is(14.0) || is(10.0)) {
      eyes += eye(p, vec2(-0.3, 0.12), 0.05, eh * 0.7) + eye(p, vec2(0.3, 0.12), 0.05, eh * 0.7);
    }
    if (is(14.0)) {
      eyes += eye(p, vec2(0.0, 0.48), 0.06, eh * 0.8) + eye(p, vec2(-0.22, -0.1), 0.04, eh * 0.6) + eye(p, vec2(0.22, -0.1), 0.04, eh * 0.6);
    }
    if (is(13.0) || is(14.0)) mouth += grin(p, vec2(0.0, 0.1), 0.17, 0.05 + 0.03 * sin(t * 1.4));
    eyes = clamp(eyes + mouth * 0.9, 0.0, 1.0);

    // 霧（three.js の FogExp2 と同じ式）。体は霧に溶け、目は少しだけ霧を抜けて見える
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    vec3 bodyCol = mix(col, uFogColor, fog * 0.9);
    vec3 rgb = bodyCol * alpha + auraCol * aura * 0.55 * (1.0 - fog)
             + uEye * eyes * (2.6 + uLock * 1.5) * (1.0 - fog * 0.6)
             + vec3(1.0) * uFlash * alpha;
    float a = clamp(alpha + aura * 0.35 * (1.0 - fog) + eyes, 0.0, 1.0);
    gl_FragColor = vec4(rgb * uOpacity, a * uOpacity);
  }
`

export type ShadeMaterial = THREE.ShaderMaterial & {
  uniforms: {
    uTime: { value: number }
    uSeed: { value: number }
    uLock: { value: number }
    uFlash: { value: number }
    uShape: { value: number }
    uFogDensity: { value: number }
    uOpacity: { value: number }
    uEye: { value: THREE.Color }
    uAura: { value: THREE.Color }
    uFogColor: { value: THREE.Color }
  }
}

export function createShadeMaterial(shape: ShapeName, aura: THREE.ColorRepresentation,
                                    fogColor: THREE.ColorRepresentation, fogDensity: number,
                                    eyeColor?: THREE.ColorRepresentation): ShadeMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: Math.random() },
      uLock: { value: 0 },
      uFlash: { value: 0 },
      uShape: { value: SHAPES[shape] },
      uFogDensity: { value: fogDensity },
      uOpacity: { value: 1 },
      uEye: { value: new THREE.Color(eyeColor ?? EYE_COLORS[shape]) },
      uAura: { value: new THREE.Color(aura) },
      uFogColor: { value: new THREE.Color(fogColor) },
    },
  })
  return mat as ShadeMaterial
}
