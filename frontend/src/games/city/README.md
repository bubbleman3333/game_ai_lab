# games/city/ GETAWAY ― 逃がし屋 ―（GTA 風 3D オープンワールド）

`/city`。車で街を走り回る 3D オープンワールド。通行人・一般車・信号・警察（パトカー・警官・ヘリ）・
手配度・物語（4 章）・寄り道のミッション・昼夜・天気がある。

**ブラウザだけで完結する**（Python 版も学習もまだ無い）。そのため CLAUDE.md の「Python 版と TS 版を両方直す」
「fixtures を作り直す」は、このゲームには当てはまらない。
警察・一般車・通行人の動きはルールベース。`sim/police.ts` の `PoliceDriver` は「状態 → Controls」の形にしてあるので、
将来は強化学習の方策に差し替えられる。

街・車・建物・景色はプログラムで作っている（画像ファイルなし）。次の 3 つだけは外部の素材を使う。

| 素材 | 置き場所 | 出典・ライセンス |
|---|---|---|
| セリフの声（物語・警官・野次馬・悲鳴、約 100 本） | `public/city/voice/` | VOICEVOX で作成（下の「声の作り方」）。**クレジット表記が必要**（タイトル画面の下に表示している） |
| 人の 3D モデル（骨格・24 種類の動きつき） | `public/city/people/` | Quaternius「Ultimate Modular Men Pack」「Ultimate Modular Women Pack」（CC0）。poly.pizza から glb を取得 |
| 効果音の一部（ガラス・金属・打撃・ドア・クラクション・車の流れ） | `public/city/sfx/` | OpenGameArt.org「75 CC0 breaking / falling / hit sfx」「100 CC0 SFX #2」「Car Sound Effects Pack (Low Quality)」（CC0） |

エンジン・タイヤ・サイレン・ヘリ・爆発などの音は、今も Web Audio で合成している（録音が無い音）。

## 声の作り方（VOICEVOX）

セリフは `sim/voiceLines.ts` に集めてある（物語は `sim/story.ts` から自動で集める）。
セリフを足したり直したりしたら、VOICEVOX を起動してから:

```powershell
cd frontend; node scripts/city-voices.ts
```

まだ音声が無いセリフだけ作って `public/city/voice/<key>.mp3` に置く（key は名前とセリフのハッシュ）。
音声が無いセリフは、ゲーム中はブラウザの音声合成で読む（`speech.ts`）。声の割り当ては `scripts/city-voices.ts` の `SPEAKERS`。
**新しいキャラクターの声を使うときは、そのキャラクターの利用規約を確認し、クレジットを `pages/CityPage.tsx` に足すこと。**
VOICEVOX の各キャラクターの規約は「犯罪の助長を目的とした作品」「公序良俗に反する使い方」を禁じているので、
人をはねることをあおるようなセリフには声を付けない。

## 依存の向き

```
pages → components → scene / audio / speech → sim
```
`sim/` は three.js にも React にも依存しない（テストは `sim/city.test.ts`）。

## ファイル

| ファイル | 中身 |
|---|---|
| `sim/maps.ts` | **街の一覧**。大きさ（区画の数）・中心街の位置・公園・倉庫街・テーマ。街を足すときはここに 1 つ足すだけ |
| `sim/cityMap.ts` | 街の地図（道路の格子・区画・建物・街灯・信号・木）を種つき乱数で作る。当たり判定の検索・信号の色 |
| `sim/vehicle.ts` | 車 1 台の運動（二輪モデル・タイヤのスリップ角・グリップの限界・横滑り防止）と衝突 |
| `sim/traffic.ts` | 一般車の運転（左側通行の車線・信号・車間・右折待ち・車線変更） |
| `sim/pedestrians.ts` | 通行人（歩道を歩く・横断歩道を信号どおり渡る・逃げる・はねられる）と、パトカーから降りる警官 |
| `sim/police.ts` | パトカーの運転（追跡・逃げる標的・職質で近づいて止まる） |
| `sim/heli.ts` | 警察のヘリ（★3 で追跡、★4 から銃撃） |
| `sim/missions.ts` | ミッション（配達・移動・暴走・逃走・チェックポイント・標的の車を壊す） |
| `sim/story.ts` | **物語**（4 章 16 ミッションと会話）。話を直すときはここだけ |
| `sim/game.ts` | 1 回ぶんのゲーム。上を全部まとめて進める（手配度・逮捕・大破・水没・職質・車の乗り換え・へこみ） |
| `scene/CityScene.ts` | three.js の組み立て（空・太陽と月・昼夜・霧・影・ブルーム・カメラ） |
| `scene/buildCity.ts` | 街の 3D（道路・標示・歩道・建物・店・街灯・信号・木・海） |
| `scene/textures.ts` | canvas で描くテクスチャ（アスファルト・敷石・窓の並んだ壁・店の並び・水面） |
| `scene/carModels.ts` | 車の 3D（輪郭の押し出し → 丸める）。へこみ（頂点を押し込む）とガラスの割れ |
| `scene/pedSkinned.ts` | **近くの人**（約 36 人）を、骨格つきの人のモデルとアニメーションで描く |
| `scene/pedModels.ts` | 遠くの人（軽いモデル。関節で曲がる手足・顔の絵）。部品ごとに InstancedMesh |
| `scene/heliModel.ts` | ヘリの 3D |
| `scene/scenery.ts` | 街の外の景色（観覧車・灯台・クレーン・吊り橋・船・島の夜景・雲） |
| `scene/effects.ts` | 煙・火・火花・爆発・ガラス片・タイヤ痕・弾の筋・水しぶき・雨と雪 |
| `scene/themes.ts` | 街ごとの見た目（天気・霧・雪・濡れた路面） |
| `audio.ts` | 音（3D 定位・ドップラー・残響。エンジン・タイヤ・衝突・ガラス・サイレン・ヘリ・銃声・環境音） |
| `voice.ts` | VOICEVOX の音声を鳴らす（位置つき・無線の音） |
| `speech.ts` | 会話の読み上げ（VOICEVOX の音声 → 無ければブラウザの音声合成） |
| `sim/voiceLines.ts` | 声を付けるセリフの一覧（職質・拡声器・野次馬・悲鳴・叫び） |
| `input.ts` | キー・マウス・スマホのボタン → 入力 |
| `components/` | canvas（毎フレームのループ）・HUD・ミニマップ・スマホのボタン |
| `pages/CityPage.tsx` | タイトル画面（物語・街選び・車・画質）と走る画面。進み具合は localStorage |

## 決まりごと

- **向き**: レースと同じ（`games/racer/README.md` の「向きの決まり」）。前 = `(sin yaw, cos yaw)`、
  右 = `(−cos yaw, sin yaw)`、右に曲がると yaw は減る。three.js のモデルのローカル +x は運転者の**左**。
- **左側通行**。車線は進む向きの左側（`leftOf()`）。右ハンドルなので警官は右側（運転席側）の窓へ来る。
- 街の大きさは `setCitySize()` で切り替わる（`BLOCKS` などは `export let`）。同時に動かす街は 1 つだけ。
- 車・人・パトカーは自分のまわり（約 250m）にだけ置き、遠くのものは消して近くに補充する。
- 夜の窓・街灯・船の明かりは、本物のライトではなく「光る面」＋ブルーム（ライトを何千個も置くと重いため）。
  本物のライトは太陽（月）・自分のヘッドライト・パトカーの赤青・ヘリのサーチライト・爆発だけ。
- 鳴らしっぱなしの音は `CityAudio.stop()` で必ず止める（`components/CityCanvas.tsx` の後始末）。

## 調整の目安（数値の置き場所）

| 何を | どこ |
|---|---|
| 自分の車の頑丈さ・修理の速さ | `sim/game.ts` の `PLAYER_ARMOR`・`PLAYER_REPAIR` |
| 手配が解けるまでの時間・逮捕までの時間 | `EVADE_BASE`・`EVADE_PER_STAR`・`BUST_SECONDS` |
| ★ごとのパトカーの数 | `COPS_FOR_STARS` |
| 職質が来るまでの時間・職質の長さ | `QUESTION_AFTER`・`QUESTION_TIME` |
| 護岸を乗り越える速さ | `sim/vehicle.ts` の `WALL_JUMP` |
| 車の性能 | `sim/vehicle.ts` の `SPECS`（見た目は `scene/carModels.ts` の `PROFILES`） |

## デバッグ

コンソールから `window.__city`（`game` と `scene`）を見られる。
`window.__cityCam = { p: [x, y, z], t: [x, y, z] }` でカメラを固定できる（`delete window.__cityCam` で戻る）。
