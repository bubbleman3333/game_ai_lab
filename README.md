# Game AI Lab

ゲームと、強化学習で育てる AI。DRF（Django REST Framework）+ React。

| ゲーム | 画面 | AI のしくみ |
|---|---|---|
| テトリス | `/tetris/play` ひとりで・`/tetris/vs-ai` AI と対戦・`/tetris/online` オンライン対戦・`/tetris/stats` 強さ | 「置いた後の盤面の価値」をニューラルネット（PyTorch）で学習（DQN 系） |
| ブロブチェイン | `/blob` ひとりで・`/blob/vs-ai` AI と対戦・`/blob/online` オンライン対戦・`/blob/stats` 強さ | テトリスと同じ DQN 系。報酬を変えた **2 種類**（対戦型 / 連鎖オンリー）を同じ仕組みで育てる |
| オセロ | `/othello` AI と対局・`/othello/stats` 強さ | 形ごとの点数（n-tuple）を自己対戦の TD 学習で育て、アルファベータ法で先読み |
| エアホッケー | `/airhockey` AI と対戦・`/airhockey/stats` 強さ | 学習なし AI の模倣から始め、PPO（強化学習）で自己対戦 |
| レース（3D） | `/racer` 走る・`/racer/stats` 強さ | 学習なしの運転者の模倣から始め、PPO（強化学習）。描画は three.js |
| 将棋 | `/shogi` AI と対局 | 強豪 AI 同士の棋譜（floodgate）で ResNet を教師あり学習し、モンテカルロ木探索（dlshogi 方式） |

## 起動（Windows / PowerShell）

```powershell
# 1. backend（初回だけ上の 4 行）
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements-dev.txt
.\.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py runserver 8000

# 2. frontend（別のターミナルで。初回だけ npm install）
cd frontend
npm install
npm run dev          # → http://localhost:5173 を開く（開発用。保存すると即反映）
```

スマホでも遊べる（テトリスは画面下の操作ボタン、ほかはタップ・指で操作）。

## 公開する（Cloudflare のクイックトンネル。アカウント不要）

```powershell
cd frontend
npm run build                      # 公開用にまとめる（開発用のままだとトンネル越しに読み込みが終わらないことがある）
npx vite preview --strictPort      # http://localhost:5173 で公開用の画面を配信（/api と /ws は Django へ転送）
..\tools\cloudflared.exe tunnel --url http://localhost:5173   # 表示される https://xxxx.trycloudflare.com が公開 URL
```
- URL は cloudflared を起動するたびに変わる。この PC と Django・preview が動いている間だけ公開される。
- Django は開発用の設定のまま（エラー時に内部情報が出る）。本格的に公開するなら backend/README.md の「公開するとき」を設定する。
- `tools/cloudflared.exe` は Cloudflare 公式のツール（Git には入れない）。

## AI を学習させる（学習はこの PC で動くので Claude のトークンは使わない）

```powershell
cd backend
.\.venv\Scripts\python -m rl.tetris.train --run-name v1     # テトリス（GPU）→ backend/rl/tetris/README.md
.\.venv\Scripts\python -m rl.blob.train --run-name v1-versus --reward-preset versus  # ブロブチェイン: 対戦型
.\.venv\Scripts\python -m rl.blob.train --run-name v1-chain  --reward-preset chain   # ブロブチェイン: 連鎖オンリー
.\.venv\Scripts\python -m rl.othello.train --run-name v1    # オセロ（CPU 並列）→ backend/rl/othello/README.md
.\.venv\Scripts\python -m rl.airhockey.train --run-name v1  # エアホッケー（CPU）→ backend/rl/airhockey/README.md
.\.venv\Scripts\python -m rl.racer.train --run-name v1      # レース（CPU）→ backend/rl/racer/README.md
.\.venv\Scripts\python -m rl.shogi.train --run-name v1      # 将棋（GPU。先に棋譜の準備が要る）→ backend/rl/shogi/README.md
.\.venv\Scripts\python manage.py sync_runs                  # 結果を強さページに取り込む
```

## 利用状況・ログ

- **今誰が遊んでいるか**: `/monitor` を開き、合言葉（`backend/.monitor_token` の中身）を入れる。5 秒ごとに更新。
  ゲームごとの人数・スマホか PC か・ニックネーム・今日の対局数・最近の対局結果・画面やサーバーのエラーが見られる。
- **ログファイル**: `backend/logs/app.jsonl`（サーバーの警告・エラー）、`backend/logs/events.jsonl`（対局の結果など）。
  1 行 1 件の JSON で、日付ごとに切り替わって 30 日分残る。Elasticsearch などにそのまま取り込める形。
- IP アドレスは記録しない。画面ごとの ID はタブを閉じると消えるランダムな文字列。仕組みは `backend/apps/monitoring/`。

## フォルダの地図（どこを読めばよいか）

```
docs/
  TETRIS_RULES.md         テトリスのルール仕様（Python 版と TS 版の共通仕様）
  TETRIS_OPPONENT_AWARE.md テトリス AI に相手の盤面を見せる設計（未実装）
  OTHELLO.md              オセロのルールと AI の設計
shared/fixtures/<ゲーム>/  Python 版と TS 版が同じ動きをするか確かめるテストデータ
shared/courses/*.json     レースのコース（1 つ足すと画面の一覧に出る）→ frontend/src/games/racer/README.md
shared/cars/*.json        レースの車の性能（見た目は frontend 側）
backend/                  Django + DRF + Channels                       → backend/README.md
  games/<ゲーム>/          ルールエンジン（純粋な Python。Django に依存しない）
  rl/<ゲーム>/             学習（Django に依存しない）                    → backend/rl/<ゲーム>/README.md
  rl/common.py            学習結果の置き場所など共通部分
  apps/training/          学習結果の取り込みと表示用 API（ゲーム共通）      → backend/apps/training/README.md
  apps/tetris_ai/         テトリス AI の手を返す API                     → backend/apps/tetris_ai/README.md
  apps/blob_ai/           ブロブチェイン AI の手を返す API                → backend/apps/blob_ai/README.md
  apps/tetris_online/     オンライン対戦（テトリス・ブロブチェイン共通。REST + WebSocket） → backend/apps/tetris_online/README.md
  apps/othello/           オセロの重み配信・棋譜の保存                    → backend/apps/othello/README.md
  apps/airhockey/         エアホッケーの方策の配信・試合結果              （中身は views.py の先頭のコメント）
  apps/racer/             レースの方策の配信・走行記録                   → backend/apps/racer/README.md
  apps/shogi/             将棋の対局（ルール判定・AI の探索はサーバー）     （中身は views.py の先頭のコメント）
  apps/monitoring/        利用状況（今誰が遊んでいるか）・出来事とエラーの記録
  logs/                   ログ（Git には入れない）
  data/                   学習用データ（将棋の棋譜など。Git には入れない）
  runs/<ゲーム>/<学習名>/  学習結果（Git には入れない）
frontend/                 React + TypeScript (Vite)                    → frontend/README.md
  src/games/<ゲーム>/      ゲームごとの エンジン・画面・API 呼び出し
                          （ブロブチェインは src/games/blob/README.md、レースは 3D → src/games/racer/README.md）
  src/components/         ゲーム共通の部品（強さページ・グラフ）
```

### ゲームを足すとき
`backend/games/<名前>/`・`backend/rl/<名前>/`・`backend/apps/<名前>/`・`frontend/src/games/<名前>/` を作り、
`config/settings.py`（INSTALLED_APPS）・`config/urls.py`・`frontend/src/App.tsx`・`frontend/src/pages/HomePage.tsx` に登録する。
学習結果を `runs/<名前>/<学習名>/` に同じ形式（config.json / metrics.jsonl / evals.jsonl / status.json）で書けば、
強さページ（`components/TrainingStats.tsx`）はそのまま使える。

## テスト

```powershell
cd backend;  .\.venv\Scripts\python -m pytest     # エンジン・API・WebSocket
cd frontend; npm test                              # TS エンジンが Python 版と一致するか
```
