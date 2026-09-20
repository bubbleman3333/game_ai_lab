# frontend（React + TypeScript + Vite）

```powershell
npm install
npm run dev      # http://localhost:5173（/api と /ws は localhost:8000 の Django へ転送）
npm test         # TS エンジンが Python 版と同じ結果になるか（テトリス・オセロ・エアホッケー・レース）
npx tsc -b       # 型チェック
npm run build    # dist/ に出力
```

## 中身
```
src/
  App.tsx                 画面の一覧（ルーティング）
  pages/HomePage.tsx      トップ（ゲームの一覧）
  api/                    ゲーム共通の API 呼び出し（client.ts: fetch の土台、training.ts: 学習結果、
                          online/: オンライン対戦の部屋と WebSocket。protocol.ts は backend の protocol.py と対）
  components/             ゲーム共通の部品（TrainingStats: 強さページ、LineChartCard: グラフ、
                          online/OnlineLobby: 対戦ロビー、ThemeToggle: 明るい／暗い配色の切り替え）
  lib/                    共通の部品（sound.ts: 効果音の土台と音量設定、useGameLoop: 毎フレームの更新、usePlayerName）
  games/tetris/
    engine/               ルールエンジン（Python 版と同じ。docs/TETRIS_RULES.md）。React 非依存
    engine/controller.ts  時間の処理（重力・ロック遅延）
    game/                 画面とエンジンをつなぐ部品（keyboard.ts: キー入力と DAS/ARR、settings.ts: 保存された設定、aiPlayer.ts、onlineMatch.ts）
    sounds.ts             効果音（どの操作でどの音を鳴らすか）
    api/                  テトリス AI の API
    components/ pages/    画面
  games/othello/
    engine/board.ts       ルール（Python 版と同じ。docs/OTHELLO.md）
    engine/evaluators.ts  評価関数（学習した n-tuple / マスの重み表）
    engine/search.ts      先読み（アルファベータ法・反復深化・終盤の完全読み）と強さの設定 LEVELS
    ai/                   探索を Web Worker で動かす（worker.ts）・評価関数の読み込み（aiLoader.ts）
    sounds.ts             効果音
    api/ components/ pages/
  games/blob/             ブロブチェイン（落ち物パズル。AI なし）→ games/blob/README.md
  games/racer/            レース（3D。three.js で描画。物理は Python 版と共通）→ games/racer/README.md
  styles.css              色は CSS 変数で指定（暗い配色が基本。`:root[data-theme='light']` で明るい配色）
```
依存の向き: `pages → components / game / ai → api / engine`（engine は何にも依存しない）。

## デバッグ
- テトリスの `/tetris/play` と `/tetris/vs-ai` では、コンソールから `window.__tetris` を見られる。
  例: `__tetris.controller.game.board.toStrings().join('\n')`
- テトリス AI の手は Network タブの `/api/tetris/move/` で見られる（`path` が操作列）。
- オセロの AI の読みは画面右の「読み・予想・読んだ局面」に出る。「評価値を表示」で各手の予想石差も見られる。

## テトリスのキー設定
画面の「キー設定」（`/tetris/settings`）で変えられ、ブラウザに保存される（`src/games/tetris/game/settings.ts`）。
初期設定は `src/games/tetris/game/keyboard.ts` の `DEFAULT_KEYS`（`KeyboardEvent.code` で指定）と `DEFAULT_HANDLING`（DAS/ARR）。
画面下の操作説明は保存された設定から自動で作られる。

## テトリスの AI の速さ・対戦の設定
- AI の速さは PPS（1 秒に置くミノの数）で選ぶ（`components/AiControls.tsx` の `AI_SPEEDS`）。
  人の PPS に合わせると、組み方（火力の効率）の勝負になる。`game/aiPlayer.ts` は前のハードドロップの時刻から
  次の手の時間を数えるので、画面のフレームの遅れがたまって PPS が下がることはない。
- 「AI と対戦」の「ミノの順番」で、両者のツモ順を同じにするか別々にするかを選べる。

## 効果音
音声ファイルは使わず、Web Audio でその場で作っている（`src/lib/sound.ts`）。
音色を変えたいときは `src/games/<ゲーム>/sounds.ts` だけを直す。音量・ミュートは画面右上（ブラウザに保存）。

- `sound.tone()` / `sound.noise()` … 一度鳴って消える音
- `sound.drone()` / `sound.noiseLoop()` … 止めるまで鳴り続け、音程と音量を変え続けられる音
  （レースのエンジン音などで使う）。**使い終わったら必ず `stop()` を呼ぶこと**

## 公開するとき
`npm run build` の `dist/` を静的ホスティングに置く。API が別ドメインなら
`VITE_API_BASE=https://api.example.com`、`VITE_WS_BASE=wss://api.example.com` を指定してビルドする。
