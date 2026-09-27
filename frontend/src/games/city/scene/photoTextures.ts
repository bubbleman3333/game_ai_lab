// 写真から作った PBR テクスチャ（public/city/tex/、Poly Haven・CC0）を読み込む。
// 1 種類につき 3 枚: diff（色）・nor（凹凸。OpenGL 形式の法線マップ）・rough（つや）。
//
// 読み込みには少し時間がかかるので、街はまず canvas で描いたテクスチャで作り、
// 読み込めたら buildCity の applyPhotos() で差し替える（その間も遊べる）。

import * as THREE from 'three'

const BASE = `${import.meta.env.BASE_URL}city/tex/`

export const PHOTO_NAMES = ['asphalt', 'pavers', 'concrete', 'brick', 'tiles', 'grass', 'iron', 'gravel', 'roof', 'plaster'] as const
export type PhotoName = (typeof PHOTO_NAMES)[number]

export interface PhotoSet { diff: THREE.Texture; nor: THREE.Texture; rough: THREE.Texture }
export type Photos = Record<PhotoName, PhotoSet>

export function loadPhotos(maxAniso: number): Promise<Photos> {
  const loader = new THREE.TextureLoader()
  const load = (file: string, color: boolean) => new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(`${BASE}${file}.jpg`, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.anisotropy = maxAniso
      if (color) t.colorSpace = THREE.SRGBColorSpace
      resolve(t)
    }, undefined, reject)
  })
  return Promise.all(PHOTO_NAMES.map(async (n) => {
    const [diff, nor, rough] = await Promise.all([load(`${n}_diff`, true), load(`${n}_nor`, false), load(`${n}_rough`, false)])
    return [n, { diff, nor, rough }] as const
  })).then((list) => Object.fromEntries(list) as Photos)
}

/** 同じ画像を、繰り返しの細かさだけ変えて使う */
export function repeated(t: THREE.Texture, r: number): THREE.Texture {
  const c = t.clone()
  c.repeat.set(r, r)
  c.needsUpdate = true
  return c
}

/**
 * 壁のマテリアルに「窓以外の壁の部分だけ写真の質感を重ねる」処理を足す。
 *   窓かどうかは、壁の絵のつや（roughnessMap）で見分ける（窓はつるつる = 暗い）。
 *   壁の部分の色を写真の色に置き換え、凹凸（法線）も壁の部分にだけ効かせる。
 * repeat は、壁の絵 1 枚（窓 8 列 × 8 階）の中に写真を何回繰り返すか（横・縦）
 */
export function addWallDetail(mat: THREE.MeshStandardMaterial, photo: PhotoSet, repeatU: number, repeatV: number, mix = 0.85): void {
  const detail = photo.diff.clone()
  detail.needsUpdate = true
  const nor = photo.nor.clone()
  nor.repeat.set(repeatU, repeatV)
  nor.needsUpdate = true
  mat.normalMap = nor
  mat.normalScale = new THREE.Vector2(0.9, 0.9)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.cityDetail = { value: detail }
    shader.uniforms.cityRepeat = { value: new THREE.Vector2(repeatU, repeatV) }
    shader.uniforms.cityMix = { value: mix }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D cityDetail;
        uniform vec2 cityRepeat;
        uniform float cityMix;
        float cityWallMask;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // 窓はつるつる（つやの絵が暗い）、壁はざらざら（明るい）
        cityWallMask = smoothstep(0.45, 0.8, texture2D(roughnessMap, vRoughnessMapUv).g) * cityMix;
        vec3 cityPhoto = texture2D(cityDetail, vMapUv * cityRepeat).rgb;
        // 壁の絵の明るさを少し残して、同じ写真でも建物ごとに色味が変わるようにする
        vec3 cityTint = mix(vec3(1.0), diffuseColor.rgb / max(dot(diffuseColor.rgb, vec3(0.333)), 0.05), 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, cityPhoto * cityTint, cityWallMask);`)
      .replace('#include <normal_fragment_maps>', `vec3 cityBaseNormal = normal;
        #include <normal_fragment_maps>
        normal = normalize(mix(cityBaseNormal, normal, cityWallMask));`)
  }
  mat.customProgramCacheKey = () => `cityWall-${repeatU}-${repeatV}-${mix}`
  mat.needsUpdate = true
}
