# games/blob/ ブロブチェイン（落ち物パズル・AI なし）

同じ色を 4 つ以上つなげると消え、落ちた粒がまたつながると「連鎖」。一人用とオンライン対戦（2 人）。
ルールも描画もブラウザだけで動く（サーバーはオンライン対戦の中継だけ。テトリスと同じ `apps/tetris_online/` を `game="blob"` で使う）。

| ファイル | 中身 |
|---|---|
| `engine/rules.ts` | 盤の大きさ（6×13、見えるのは 12 段）・色・得点の表（連鎖ボーナスなど）・乱数。React 非依存 |
| `engine/game.ts` | `BlobGame`: 1 人分の状態と操作（移動・回転・固定・1 段ずつの消去 `popStep`・落下 `settle`・おじゃま） |
| `engine/controller.ts` | `BlobController`: 時間の進行（落下・接地・消える／落ちるアニメーション）と出来事 `on()` |
| `engine/engine.test.ts` | エンジンのテスト |
| `game/input.ts` | キー操作（押しっぱなしの連続移動）。スマホのボタンからも `press/release` で使う |
| `game/onlineMatch.ts` | `BlobOnlineMatch`: 対戦 1 試合分（攻撃・おじゃま受信・盤面の送信・ゲームオーバーの通知） |
| `components/BlobCanvas.tsx` | canvas での描画（粒・つながり・ゴースト・はじける演出・連鎖の文字・揺れ）、`PairPreview`、相手の盤 `MiniField` |
| `components/BlobPlayer.tsx` | 1 人分の画面（盤・ネクスト・得点・予告おじゃま） |
| `components/BlobTouch.tsx` | スマホの操作ボタン |
| `sounds.ts` | 効果音（連鎖ごとに音が上がる） |
| `pages/BlobSoloPage.tsx` | 一人用 `/blob`（30 組ごとに速くなる。ハイスコアはブラウザに保存） |
| `pages/BlobOnlineRoomPage.tsx` | 対戦の部屋 `/blob/online/:code`。ロビーは共通の `components/online/OnlineLobby.tsx` |

## ルールの要点
- 得点 = 消した数 × 10 × (連鎖ボーナス + 色数ボーナス + 連結ボーナス)（`chainScore`）
- 70 点ごとにおじゃま 1 個。自分に来ている予告と先に相殺し、余りを相手へ（`popStep` の `cancelled` / `sent`）
- 予告は連鎖が終わってから、1 回に最大 30 個（5 段）降る。全消しすると次の消去に 30 個分のボーナス
- 左から 3 列目の 12 段目（× 印）がふさがると負け

## 対戦の通信
形はテトリスと共通（`src/api/online/protocol.ts`）。`state` の `rows` は下の行から各行 6 文字（'0' 空き / '1'〜'4' 色 / '5' おじゃま）。
`stats` は pieces = 置いた組 / lines = 最大連鎖 / attack = 送った数。`attack` は 1 通 30 個までなので分けて送る。

## デバッグ
`npx vitest run src/games/blob` でエンジンを確かめられる。色は `styles.css` の `--blob-1`〜`--blob-4`・`--blob-garbage`（明るい配色は `[data-theme='light']`）。
