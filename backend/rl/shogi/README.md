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
| `mcts.py` | モンテカルロ木探索（仮の負けを使って GPU でまとめて評価。木の使い回し・先読み・詰みの優先） |
| `evaluator.py` | 探索中の局面をまとめてネットで評価（fp16 + CUDA グラフ。GPU の計算中に次のバッチを集める） |
| `mate.py` | 根の局面で長い詰みを探す（cshogi の df-pn。GIL を握るので別プロセスで動かす） |
| `evaluate.py` | 2 つの AI を対局させて強さ（勝率・Elo の差）を比べる |

## 手順
```powershell
cd backend
# 1. 棋譜を用意（data/shogi/ に floodgate の年ごとの 7z を置いて展開）
# 2. 学習用データに変換（2025 年分で約 20 分、約 820 万局面）
.\.venv\Scripts\python -m rl.shogi.prepare data/shogi/floodgate2025 --min-rating 3000
# 3. 学習（GPU。全データ 4 周で数時間）
.\.venv\Scripts\python -m rl.shogi.train --run-name v1
# v2: ネットを大きくし、価値の正解に「指した AI の評価値」を混ぜる（RTX 3060 で約 5 時間）
.\.venv\Scripts\python -m rl.shogi.train --run-name v2 --blocks 15 --channels 192 --eval-mix 0.5 --epochs 5 --workers 8
# 4. 強さを比べる（互角の局面から先後を入れ替えて対局）
.\.venv\Scripts\python -m rl.shogi.evaluate --a v2:best --b v1:best --games 40 --time 1
```
学習中の「指し手の一致率」（テスト局面で、強い AI と同じ手を選べた割合）が強さの目安。dlshogi 系で 40〜50% 程度。

### 価値の頭の過学習と `--eval-mix`
v1 は価値（どちらが勝つか）の損失が学習データで 0.30、テストで 0.59 と大きく離れた。
1 局の中の局面はすべて同じ「勝ち / 負け」を正解に持つので、少ない対局数だと局面ではなく対局を丸暗記してしまう。
floodgate の棋譜には指した AI の評価値が付いているので、それを勝率に直したもの（`data.EVAL_SCALE` = 600 点で約 73%）を
`--eval-mix` の割合で混ぜる（dlshogi と同じやり方）。hcpe の評価値は**先手から見た値**で入っている（data.py で手番側に直す）。

## 学習の結果
| run | ネット | 指し手の一致率 | 価値の損失（テスト / 学習） | 対局 |
|---|---|---|---|---|
| v1 | 10 ブロック × 128 | 50.3% | 0.59 / 0.30（丸暗記） | — |
| v2 | 15 ブロック × 192、`--eval-mix 0.5`、5 周 | **52.3%** | **0.475** / 0.44 | v1 に **31 勝 9 敗**（Elo +215。1 手 1 秒・40 局） |

v2 の学習は RTX 3060 で約 4.3 時間。デスクトップアプリの既定は v2（`desktop/shogi/engine.py` の `PREFERRED`）。

## 探索を速くした結果
Python で書いた探索なので、1 回あたりの手間（GPU への命令・手を選ぶ計算・結果の書き戻し）を削るのが一番効く。

| | 1 秒に読む局面 | v1 のネットどうしで対局（1 手 1 秒・20 局） |
|---|---|---|
| 元の探索 | 約 1,450 | — |
| 今の探索（numba・CUDA グラフ・2 本並行・詰み探索） | 約 5,500〜7,000 | **18 勝 2 敗**（Elo +382） |

速さは RTX 3060 で、別の学習と GPU を分け合いながら測った値。木は 1 局面あたり約 1.6KB のメモリを使うので、
`mcts.MAX_TREE_VISITS`（50 万）で止める。

## 対局
- **デスクトップアプリ**（`desktop/shogi/`）: 手元の GPU で直接考える。あなたの考慮中も先読みする。一番強く指せる
- サーバー（`apps/shogi`）: 画面からの対局。強さは読む回数で決める（`apps/shogi/services.py` の `LEVELS`）
