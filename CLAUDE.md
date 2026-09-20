# AI（Claude など）向けの作業ガイド

プロジェクト全体を読まずに済むよう、**作業に関係する入口の README だけを読む**こと。

## 最初に読むもの
1. `README.md`（全体の地図）
2. 作業する場所の README
   - テトリスのルール → `docs/TETRIS_RULES.md` と `backend/games/tetris/README.md`
   - テトリスの学習 → `backend/rl/tetris/README.md`
   - ブロブチェイン（落ち物パズル）→ `frontend/src/games/blob/README.md`、ルールの Python 版は
     `backend/games/blob/`、学習 → `backend/rl/blob/README.md`、AI の API → `backend/apps/blob_ai/README.md`
   - オセロ（ルール・AI の設計）→ `docs/OTHELLO.md`、学習 → `backend/rl/othello/README.md`
   - エアホッケー → `backend/rl/airhockey/README.md`（物理は `backend/games/airhockey/physics.py` と TS 版）
   - レース（3D）→ `frontend/src/games/racer/README.md`（コースの足し方もここ）、学習 → `backend/rl/racer/README.md`
   - 将棋 → `backend/rl/shogi/README.md`、対局 API → `backend/apps/shogi/views.py` の先頭
   - 学習結果の API・強さページ → `backend/apps/training/README.md`
   - テトリス AI の API → `backend/apps/tetris_ai/README.md`
   - オンライン対戦（テトリス・ブロブチェイン共通）→ `backend/apps/tetris_online/README.md`
   - オセロの API → `backend/apps/othello/README.md`
   - レースの API → `backend/apps/racer/README.md`
   - 画面 → `frontend/README.md`

## 守ること
- **ルールを変えたら Python 版と TS 版の両方を直す**。`python -m games.<ゲーム>.fixtures` でテストデータを
  作り直し、`pytest` と `npm test` の両方を通す。
- backend の層: `views.py` / `consumers.py`（Controller）→ `services.py`（書き込み・業務処理）/ `selectors.py`（読み取り）→ `models.py`。
  view から ORM を直接触らない。入出力の形は `serializers.py`。
- `games/` と `rl/` は Django に依存させない（学習を Django なしで回すため）。
- ブロブチェインの AI は報酬だけ変えた 2 種類（`versus` 対戦型 / `chain` 連鎖オンリー）。
  `rl/blob/config.py` の `REWARD_PRESETS` と `STYLE_DEFAULTS`。**どちらかに寄せず、両方残すこと**。
- テトリスの特徴量（`rl/tetris/encoding.py`）とブロブチェインの特徴量（`rl/blob/encoding.py`）を変えたら
  `FEATURE_VERSION`、オセロのパターン（`rl/othello/ntuple.py`）を変えたら `PATTERN_VERSION` を上げる。
  古い重みは使えなくなる。
- オンライン対戦の WebSocket のメッセージは `backend/apps/tetris_online/protocol.py` と
  `frontend/src/api/online/protocol.ts` の両方を直す（テトリスとブロブチェインで共通）。
- SQLite は WAL + `transaction_mode: IMMEDIATE`（`config/settings.py`）。外すと同時アクセスで "database is locked" が出る。
- エアホッケーの物理（`physics.py` と `physics.ts`）を変えたら `python -m games.airhockey.fixtures` で作り直す。
- レースの物理・コースの組み立て（`games/racer/` と `frontend/src/games/racer/engine/`）を変えたら
  `python -m games.racer.fixtures` で作り直す。観測の形を変えたら `rl/racer/policy.py` の `POLICY_VERSION` を上げる。
- レースのコースと車は `shared/courses/*.json` と `shared/cars/*.json`。**JSON を 1 つ置くだけで画面に出る**
  （道も景色も中心線から自動で作られる）。車の見た目だけは `frontend/src/games/racer/scene/carDesigns.ts`。
- レースの 3D は three.js を直接使う。物理エンジン（rapier 等）は入れない。Python 版と計算が一致しなくなるため。
- **レースの「右」はワールドの −x**（運転者から見た右 = `(-cos yaw, 0, sin yaw)`、右へ曲がると yaw は減る）。
  右手系で上が +y・前が +z だとこうなる。+x を右と書くと、右に切ったのに画面では左へ曲がる。
  詳しくは `frontend/src/games/racer/README.md` の「向きの決まり」。
- 鳴らしっぱなしの音（エンジン音など）は `sound.drone()` / `sound.noiseLoop()`。**必ず `stop()` で止める**。
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
cd backend; .\.venv\Scripts\python -m rl.blob.train --run-name <名前> --reward-preset <versus|chain>
cd backend; .\.venv\Scripts\python -m rl.othello.train --run-name <名前> [--workers 0 でデバッグ]
cd backend; .\.venv\Scripts\python manage.py sync_runs
cd frontend; npm test; npx tsc -b
```
