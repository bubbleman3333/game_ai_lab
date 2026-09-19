# rl/shogi/ 将棋 AI の学習（PyTorch・GPU）

dlshogi（世界コンピュータ将棋選手権の優勝ソフト）と同じ考え方。ルールと特徴量は `cshogi`（GPL-3.0）を使う。

1. **データ**: コンピュータ将棋の対局サイト floodgate の公開棋譜（強い AI 同士、レーティング 3000 以上）
2. **教師あり学習**: ResNet に「次の一手（方策）」と「この局面はどちらが勝つか（価値）」を同時に学ばせる
3. **探索**: 学習したネットでモンテカルロ木探索（PUCT）。方策で有望な手を広げ、価値で局面を評価する

| ファイル | 中身 |
|---|---|
| `prepare.py` | CSA 棋譜 → 学習用の局面データ（hcpe 形式、`data/shogi/hcpe/`） |
| `data.py` | 局面 → ネットの入力（`cshogi.dlshogi.make_input_features`）と正解 |
| `model.py` | 方策・価値の 2 つの頭を持つ ResNet（既定 10 ブロック × 128 チャンネル） |
| `train.py` | 教師あり学習（SGD + OneCycle、混合精度） |
| `mcts.py` | モンテカルロ木探索（仮の負けを使って GPU でまとめて評価） |

## 手順
```powershell
cd backend
# 1. 棋譜を用意（data/shogi/ に floodgate の年ごとの 7z を置いて展開）
# 2. 学習用データに変換（2025 年分で約 20 分、約 820 万局面）
.\.venv\Scripts\python -m rl.shogi.prepare data/shogi/floodgate2025 --min-rating 3000
# 3. 学習（GPU。全データ 4 周で数時間）
.\.venv\Scripts\python -m rl.shogi.train --run-name v1
```
学習中の「指し手の一致率」（テスト局面で、強い AI と同じ手を選べた割合）が強さの目安。dlshogi 系で 40〜50% 程度。

## 対局
サーバー（`apps/shogi`）が GPU で探索する。強さは読む回数で決める（`apps/shogi/services.py` の `LEVELS`）。
