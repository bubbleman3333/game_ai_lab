# games/blob/ ブロブチェイン（落ち物パズル）

同じ色を 4 つ以上つなげると消え、落ちた粒がまたつながると「連鎖」。一人用・AI と対戦・オンライン対戦（2 人）。
ルールも描画もブラウザで動く。サーバーを使うのは次の 2 つだけ。
- オンライン対戦の中継（テトリスと同じ `apps/tetris_online/` を `game="blob"` で使う）
- **AI の手**（`apps/blob_ai/`。1 手ごとに「どこに置くか」を聞く。学習は `backend/rl/blob/`）

| ファイル | 中身 |
|---|---|
| `engine/rules.ts` | 盤の大きさ（6×13、見えるのは 12 段）・色・得点の表（連鎖ボーナスなど）・乱数。React 非依存 |
| `engine/game.ts` | `BlobGame`: 1 人分の状態と操作（移動・回転・固定・1 段ずつの消去 `popStep`・落下 `settle`・おじゃま） |
| `engine/controller.ts` | `BlobController`: 時間の進行（落下・接地・消える／落ちるアニメーション）と出来事 `on()` |
| `engine/engine.test.ts` | エンジンのテスト |
| `game/input.ts` | キー操作（押しっぱなしの連続移動）。スマホのボタンからも `press/release` で使う |
| `game/aiPlayer.ts` | `BlobAiPlayer`: AI の操作役（API に手を聞いて操作列を実行）。速さの一覧 `BLOB_AI_SPEEDS` |
| `game/versus.ts` | 同じ画面での対戦（おじゃまの送り合い） |
| `game/onlineMatch.ts` | `BlobOnlineMatch`: 対戦 1 試合分（攻撃・おじゃま受信・盤面の送信・ゲームオーバーの通知） |
| `api/ai.ts` | AI の API 呼び出し（`/api/blob/agents/`・`/api/blob/move/`）と `useBlobAgents` |
| `api/types.ts` | その入出力の型（`apps/blob_ai/serializers.py` と対応） |
| `components/BlobCanvas.tsx` | canvas での描画（粒・つながり・ゴースト・はじける演出・連鎖の文字・揺れ）、`PairPreview`、相手の盤 `MiniField` |
| `components/BlobPlayer.tsx` | 1 人分の画面（盤・ネクスト・得点・予告おじゃま） |
| `components/BlobTouch.tsx` | スマホの操作ボタン |
| `components/BlobAiControls.tsx` | AI の選択と速さ（PPS = 1 秒に置く組の数） |
| `sounds.ts` | 効果音（連鎖ごとに音が上がる） |
| `pages/BlobSoloPage.tsx` | 一人用 `/blob`（30 組ごとに速くなる。ハイスコアはブラウザに保存。AI のお手本・おまかせつき） |
| `pages/BlobVsAiPage.tsx` | AI と対戦 `/blob/vs-ai`（AI どうしの観戦もできる） |
| `pages/BlobStatsPage.tsx` | AI の強さ `/blob/stats`（中身は共通の `components/TrainingStats.tsx`） |
| `pages/BlobOnlineRoomPage.tsx` | 対戦の部屋 `/blob/online/:code`。ロビーは共通の `components/online/OnlineLobby.tsx` |

## ルールの要点
- 得点 = 消した数 × 10 × (連鎖ボーナス + 色数ボーナス + 連結ボーナス)（`chainScore`）
- 70 点ごとにおじゃま 1 個。自分に来ている予告と先に相殺し、余りを相手へ（`popStep` の `cancelled` / `sent`）
- 予告は連鎖が終わってから、1 回に最大 30 個（5 段）降る。全消しすると次の消去に 30 個分のボーナス
- 左から 3 列目の 12 段目（× 印）がふさがると負け

## AI
AI は **2 種類**ある。`versus`（対戦型・おじゃまを送る量を最大化）と `chain`（連鎖オンリー・大連鎖を組む）で、
中身は同じネットで報酬の付け方だけが違う。学習すると別々の run になるので、AI 選択に両方並ぶ。

AI は backend が動かす（ブラウザは「どこに置くか」を聞くだけ）。しくみは
[backend/rl/blob/README.md](../../../../backend/rl/blob/README.md)、API は
[backend/apps/blob_ai/README.md](../../../../backend/apps/blob_ai/README.md)。

- `BlobAiPlayer` は**組が出るたび**に 1 回だけ聞き、返ってきた操作列（`["CW", "R", "HD"]` など）を
  `actionDelayMs` ごとに 1 つずつ controller に流す。人が遊んでいるように見せるため。
- 一人用の「お手本」は `advise: true`。聞くだけで操作はせず、`hint` に入った置き場所を
  `BlobCanvas` が点線の丸で描く（色は `--blob-hint`）。
- 盤面がずれた（おじゃまが降ってきた等）ときは、その場で落として次の手で立て直す。
- backend が止まっていても**一人用とオンライン対戦は動く**（AI を使うときだけエラーが出る）。

## 対戦の通信
形はテトリスと共通（`src/api/online/protocol.ts`）。`state` の `rows` は下の行から各行 6 文字（'0' 空き / '1'〜'4' 色 / '5' おじゃま）。
`stats` は pieces = 置いた組 / lines = 最大連鎖 / attack = 送った数。`attack` は 1 通 30 個までなので分けて送る。

## デバッグ
`npx vitest run src/games/blob` でエンジンを確かめられる。
`engine.test.ts` はルールそのもの、`fixtures.test.ts` は **Python 版（`backend/games/blob/`）と同じ結果になるか**
（`shared/fixtures/blob/engine_cases.json`。ルールを変えたら
`cd backend; .\.venv\Scripts\python -m games.blob.fixtures` で作り直す）。
色は `styles.css` の `--blob-1`〜`--blob-4`・`--blob-garbage`（明るい配色は `[data-theme='light']`）。
