# AI（Claude など）向けの作業ガイド

プロジェクト全体を読まずに済むよう、**作業に関係する入口の README だけを読む**こと。

## 最初に読むもの
1. `README.md`（全体の地図）
2. 作業する場所の README
   - テトリスのルール → `docs/TETRIS_RULES.md` と `backend/games/tetris/README.md`
   - テトリスの学習 → `backend/rl/tetris/README.md`
   - オセロ（ルール・AI の設計）→ `docs/OTHELLO.md`、学習 → `backend/rl/othello/README.md`
   - エアホッケー → `backend/rl/airhockey/README.md`（物理は `backend/games/airhockey/physics.py` と TS 版）
   - 将棋 → `backend/rl/shogi/README.md`、対局 API → `backend/apps/shogi/views.py` の先頭
   - 学習結果の API・強さページ → `backend/apps/training/README.md`
   - テトリス AI の API → `backend/apps/tetris_ai/README.md`
   - オンライン対戦（テトリス・ブロブチェイン共通）→ `backend/apps/tetris_online/README.md`
   - ブロブチェイン（落ち物パズル。AI なし・ブラウザだけで動く）→ `frontend/src/games/blob/README.md`
   - オセロの API → `backend/apps/othello/README.md`
   - 画面 → `frontend/README.md`

## 守ること
- **ルールを変えたら Python 版と TS 版の両方を直す**。`python -m games.<ゲーム>.fixtures` でテストデータを
  作り直し、`pytest` と `npm test` の両方を通す。
- backend の層: `views.py` / `consumers.py`（Controller）→ `services.py`（書き込み・業務処理）/ `selectors.py`（読み取り）→ `models.py`。
  view から ORM を直接触らない。入出力の形は `serializers.py`。
- `games/` と `rl/` は Django に依存させない（学習を Django なしで回すため）。
- テトリスの特徴量（`rl/tetris/encoding.py`）を変えたら `FEATURE_VERSION`、
  オセロのパターン（`rl/othello/ntuple.py`）を変えたら `PATTERN_VERSION` を上げる。古い重みは使えなくなる。
- オンライン対戦の WebSocket のメッセージは `backend/apps/tetris_online/protocol.py` と
  `frontend/src/api/online/protocol.ts` の両方を直す（テトリスとブロブチェインで共通）。
- SQLite は WAL + `transaction_mode: IMMEDIATE`（`config/settings.py`）。外すと同時アクセスで "database is locked" が出る。
- エアホッケーの物理（`physics.py` と `physics.ts`）を変えたら `python -m games.airhockey.fixtures` で作り直す。
- 公開中（Cloudflare トンネル + `vite preview`）は、画面を直したら `cd frontend; npx vite build` で反映する。
- Django の開発サーバーはファイルを保存すると自動で再起動する。**新しいアプリは、ファイルを全部作ってから settings / urls に登録する**
  （先に登録すると再起動に失敗して止まる）。
- 対局の結果など残したい出来事は `apps.monitoring.services.record_event()` で記録する（監視ページ `/monitor` とログに出る）。
- 不具合の調査は、まず `backend/logs/app.jsonl` と `/monitor` の「最近の出来事」を見る。
- コメント・README は日本語。

## よく使うコマンド（backend は `backend/.venv` を使う）
```powershell
cd backend; .\.venv\Scripts\python -m pytest
cd backend; .\.venv\Scripts\python -m rl.tetris.train --run-name <名前> [--workers 0 でデバッグ]
cd backend; .\.venv\Scripts\python -m rl.othello.train --run-name <名前> [--workers 0 でデバッグ]
cd backend; .\.venv\Scripts\python manage.py sync_runs
cd frontend; npm test; npx tsc -b
```
