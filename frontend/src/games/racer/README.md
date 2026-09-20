# games/racer/ レース（3D）

3 つのコースを走る周回レース。坂をのぼりきったところやジャンプ台で宙に浮き、空中で半回転してから
着地するとブーストがもらえる。相手は「学習なしの運転者」か「強化学習で育てた AI」。

描画は **three.js**（`npm install three` だけ。React 用のラッパーは使っていない）。
物理エンジンは使わず、走りの計算は自前で書いている。理由は次のとおり。

## いちばん大事な決まり: 見た目は 3D、計算は「平面 + 高さ」

3D に見えるが、計算しているのは平面の上を走る車と、その高さだけ。車体の変形もタイヤ 4 本ぶんの
サスペンションも計算していない。

そうしている理由は、**同じ計算を Python 版（`backend/games/racer/`）にも持っているから**。
AI は Python 側で学習させ、その重み（小さなニューラルネット）だけをブラウザに配って動かす。
つまり両方の計算が 1 つでもずれると、学習したはずの走りがブラウザで再現されない。
`shared/fixtures/racer/engine_cases.json` を使って、両版が同じ結果を出すか `engine.test.ts` で確かめている。

物理エンジン（rapier など）を入れると、この一致が保てないので使っていない。
three.js の担当は**描画とカメラだけ**。

ジャンプは特別扱いしていない。接地しているあいだ、車は「地面の高さの変わりぶん」をそのまま
上向きの速度として持つ。だから坂をのぼりきったところでは、地面が下がるのに上向きの速度が残っていて、
そのまま宙に浮く。速く走るほど遠くまで飛ぶ。

## ファイル

| ファイル | 中身 |
|---|---|
| `engine/course.ts` | コースの読み込み。ウェイポイントを曲線でつなぎ、約 1m ごとの点に並べ直す。物理も 3D も景色もこの配列が土台 |
| `engine/physics.ts` | 車 1 台の運動（加速・ステア・横滑り・重力・接地・壁・ブースト・トリック・落下と復帰）。Python 版と同じ式 |
| `engine/policy.ts` | 学習した方策（小さな MLP）をブラウザで計算する |
| `engine/engine.test.ts` | Python 版と一致するかのテスト |
| `game/input.ts` | キーとスマホのボタン → アクセル・ステア・ジャンプ |
| `game/race.ts` | レース 1 回ぶん（カウントダウン・周回の計測・順位・ゴール）。3D にも React にも依存しない |
| `scene/themes.ts` | 景色の設定（空・霧・大地・光・道の色・並べる飾り）。コースの `theme` で選ばれる |
| `scene/carDesigns.ts` | 車の**見た目**（箱と円柱の寸法表）。走りの性能とは別 |
| `scene/buildCar.ts` | 寸法表から車のモデルを組み立てる |
| `scene/buildTrack.ts` | 中心線から道・縁石・中央線・ガードレール・橋脚・スタート線を作る |
| `scene/buildWorld.ts` | 空・大地・遠くの山・木や岩や街灯（同じ形は InstancedMesh でまとめて描く） |
| `scene/effects.ts` | タイヤの煙・着地のほこり・ブーストの炎 |
| `sounds.ts` | エンジン音・風・タイヤの滑る音（鳴らしっぱなし）と、単発の効果音 |
| `scene/RacerScene.ts` | three.js の組み立てと、毎フレームのカメラ・車の姿勢の更新 |
| `components/RaceCanvas.tsx` | canvas を置いて、レースと場面を毎フレーム回す |
| `components/RaceHud.tsx` | 速度・周回・タイム・順位・ブーストの表示（ふつうの HTML） |
| `components/RaceTouch.tsx` | スマホの操作ボタン |
| `pages/RacerPage.tsx` | `/racer`。コース・車・相手を選んで走る |
| `pages/RacerStatsPage.tsx` | `/racer/stats`。AI の学習の推移と人の走行記録 |

依存の向き: `pages → components → scene / game → engine`（engine は何にも依存しない）。

## 向きの決まり（左右を間違えないために）

座標は three.js と同じで **x = 右、y = 上、z = 奥**。前を向くベクトルは `(sin yaw, 0, cos yaw)`。

ここで注意がいるのは「運転者から見た右」で、**`(-cos yaw, 0, sin yaw)`** になる。
右手系で上が +y・前が +z のとき、右 = 前 × 上 = **−x** だからで、
言いかえると**画面の右はワールドの −x** 側。うっかり +x を「右」と書くと、
ハンドルを右に切ったのに画面では左へ曲がる、という不具合になる（実際に一度やった）。

- 右へ曲がると `yaw` は**減る**、左へ曲がると増える
- `steer` は +1 が右、−1 が左（画面で見たとおり）
- `bank`（道の傾き）は正なら運転者から見て右側が下がる＝右コーナーの向き
- 中心線からの左右のずれ `lateral` も、正なら運転者から見て右

## 音

音声ファイルは使わず、Web Audio でその場で作っている（土台は `src/lib/sound.ts`）。

- **鳴らしっぱなしの音**（`sound.drone()` / `sound.noiseLoop()`）: エンジン・風切り音・タイヤの滑る音。
  毎フレーム `RaceEngineSound.update()` で音程と音量を変える。`stop()` を呼ばないと鳴り続けるので、
  レース画面を閉じるときに必ず止めている（`components/RaceCanvas.tsx` の後始末）。
- **単発の音**（`racerSounds`）: カウントダウン・周回・ゴール・着地・トリック・落下・ブースト・壁。
- エンジン音は速度からギア（5 段）を出して音程を決めている。速度に比例させるだけだと、
  ずっと同じ音が上がり続けるだけで速く感じない。
- 音量とミュートは画面右上の設定（ブラウザに保存）。鳴らしっぱなしの音にもそのまま効く。

## コースを足す

**`shared/courses/` に JSON を 1 つ置くだけ**。コードは 1 行も変えなくてよい。
道も景色もガードレールも木も、その中心線から自動で作られる。

```json
{
  "id": "myloop",
  "name": "わたしのコース",
  "theme": "meadow",
  "description": "一覧に出る短い説明",
  "laps": 3,
  "width": 16,
  "waypoints": [
    { "x": 0,   "z": 170, "y": 0, "width": 20 },
    { "x": 61,  "z": 138, "y": 0 },
    { "x": 96,  "z": 86,  "y": 8 }
  ],
  "features": [
    { "kind": "boost", "from": 1, "to": 3 },
    { "kind": "ramp",  "from": 5, "length": 24, "height": 7 },
    { "kind": "gap",   "from": 5, "offset": 24, "length": 26 }
  ]
}
```

- `waypoints` は**輪**になっている（最後の次は最初）。4 個以上必要。`x` が右、`z` が奥、`y` が高さ（m）。
  点と点は滑らかな曲線でつながれるので、20 個も置けば十分。`width` と `bank`（傾き）は点ごとに上書きできる。
- 走る向きは `waypoints[0] → waypoints[1]`。スタート線は `waypoints[0]` のところに引かれる。
- `features` の仕掛け:

  | kind | 中身 |
  |---|---|
  | `boost` | 加速パネル。踏むとブーストがつく |
  | `dirt` | 砂・土。曲がりにくく加速も鈍る |
  | `ramp` | ジャンプ台。`height` m ぶん地面が坂になり、終わりが崖になる。速いほど遠くへ飛ぶ |
  | `gap` | 道が途切れる。飛び越えられないと落ちて、少し手前から再スタート |

  置き場所は `from`（ウェイポイントの番号）＋ `offset`（そこから何 m 先。省略で 0）で決め、
  終わりは `to`（別のウェイポイント）か `length`（何 m ぶん）のどちらかで書く。
  あとに書いた仕掛けが先に書いたものを上書きする。

**確かめかた**: `cd backend; .\.venv\Scripts\python -m pytest tests/racer -k course`。
「コーナーがきつすぎないか（半径 20m 未満がないか）」「輪が閉じているか」「落ちたときの戻り先が道の上か」を見てくれる。
きついコーナーができてしまったら、その付近のウェイポイントの間隔を広げるか、曲がりを浅くする。

**AI に走らせたいとき**は、コースを足したあと `python -m rl.racer.train` で学習し直す
（学習は全コースを混ぜて行うので、新しいコースも自動で対象になる）。学習し直さなくても、
既存の AI はだいたい走れる（コースの形は観測から見えているため）。

## 車を足す

2 か所に書く。

1. `shared/cars/<名前>.json` に**性能**（最高速・加速・グリップなど）。ここは Python 版と共有していて、
   変えると走りが変わる（＝ AI の学習をやり直したほうがよい）。
2. `scene/carDesigns.ts` に**見た目**（パーツの寸法と色）。ここは変えても走りに影響しない。
   書かなければ既定の見た目で走る。

## 景色（テーマ）を足す

`scene/themes.ts` の表に 1 つ足して、コースの JSON の `"theme"` にその名前を書く。
空の色・霧・大地・光の向きと強さ・道の色・並べる飾り（木・サボテン・岩・街灯・ビル）を指定する。
`terrain` を `follow` にすると大地が道の高さに沿って盛り上がり（丘や谷に見える）、
`flat` にすると平らなままで、高いところは橋脚で支えた高架に見える。

## 操作

<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> または矢印キー、<kbd>Space</kbd> でジャンプ。
スマホでは画面下のボタン。ステアは押してから少しずつ効く（`game/input.ts` の `STEER_RATE`）。

## デバッグ

- エンジンだけ確かめる: `npx vitest run src/games/racer`
- ブラウザのコンソールから物理を直接回せる（開発サーバーのとき）:
  ```js
  const P = await import('/src/games/racer/engine/physics.ts')
  const CO = await import('/src/games/racer/engine/course.ts')
  const c = CO.load('meadow'), car = P.loadCar('balanced')
  const s = P.initialState(c, 0, 0, 0)
  for (let i = 0; i < 600; i++) P.step(s, car, c, 1, 0, -1)
  s // 位置・速度・周回などが見られる
  ```
- Python 版と食い違ったら、まず `cd backend; .\.venv\Scripts\python -m games.racer.fixtures` で
  テストデータを作り直してから `npx vitest run src/games/racer`。
