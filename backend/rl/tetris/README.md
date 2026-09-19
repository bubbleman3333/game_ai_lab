# rl/tetris/ テトリスの強化学習（PyTorch）

## 何を学習しているか
GA で重みベクトルを調整する AI と同じく「盤面の特徴量 → 評価値」で手を選ぶが、
評価関数を **ニューラルネット V(置いた後の局面)** にして、**遊びながら TD 学習で重みを更新する**。

1. 今のミノ（とホールドしたミノ）の置き場所を全部出す（`games.tetris.find_placements`）
2. 置いた後の局面を特徴量ベクトル（43 次元、`encoding.py`）にする
3. `報酬 + γ × V(置いた後)` が最大の手を選ぶ（学習中は確率 ε でランダム）
4. 経験 `(a_t, r, a_{t+1}, 終了か)` を貯め、`V(a_t) ≒ r + γ V_target(a_{t+1})` になるよう重みを更新（DQN と同じ工夫: リプレイバッファ・ターゲットネット）

報酬は `config.py` の `RewardConfig`（生き残り +0.1、1 列 +0.2、火力 1 段 +1.0、ゲームオーバー -5）。
学習の途中から、ランダムなおじゃまを送って対戦に近い状況でも鍛える（`garbage_*`）。

| ファイル | 中身 |
|---|---|
| `position.py` | 局面 `Position` と、候補手の列挙 `enumerate_candidates()` |
| `encoding.py` | 候補 → 特徴量ベクトル（**変えたら `FEATURE_VERSION` を上げる**） |
| `model.py` | `ValueNet`（MLP）と重みの保存・読み込み |
| `agent.py` | `NeuralAgent`（学習した AI）・`HeuristicAgent`（比較用。固定の重み） |
| `env.py` | 学習用の環境（ランダムなおじゃまを送る） |
| `train.py` | 学習（並列の actor + GPU の learner） |
| `evaluate.py` | 決まった seed で遊ばせて強さを測る |
| `config.py` | 設定（すべてコマンドラインで上書きできる） |

## 学習する
```powershell
cd backend
.\.venv\Scripts\python -m rl.tetris.train --run-name v1                 # 既定 20000 エピソード
.\.venv\Scripts\python -m rl.tetris.train --run-name v1 --resume        # 中断した続きから
.\.venv\Scripts\python -m rl.tetris.train --help                        # 設定の一覧
```
- Ctrl+C で止めても `latest.pt` は保存される。
- `--workers 6`（既定）: 6 プロセスが並列にゲームを遊び、GPU で学習する。CPU のコア数に合わせて調整。
- `--workers 0`: 1 プロセスだけで動く。PyCharm のデバッガで追うときはこちら。

### どのくらい時間がかかるか（RTX 3060 + i7-11700F、`--workers 6` での実測）
試しに 3000 エピソード（約 9 分）回したときの評価:

| 経過 | エピソード | ひとり: 平均消去ライン（300 手まで） | おじゃまあり: 平均火力 |
|---|---|---|---|
| 1.5 分 | 1000 | 10.6 | 0.0 |
| 3.7 分 | 2000 | 51.4 | 5.2 |
| 5.9 分 | 2500 | 99.0 | 28.4 |
| 7.5 分 | 2750 | 114.0 | 33.2 |
| 9.3 分 | 3000 | 113.0 | 50.4 |
| （比較）ヒューリスティック AI | - | 118.0 | 27.7 |

9 分ほどで、火力はヒューリスティック AI（GA 型の固定重み）を大きく上回った。
T-Spin も少しずつ使い始めている。
「おじゃまあり」の評価（1 手あたり平均 0.4 段）は厳しめに作ってあり、300 手まで生き残れた AI はまだない。

うまくなるほど 1 ゲームが長くなるので、後半ほど 1 エピソードに時間がかかる。
既定の 20000 エピソードは **数時間**が目安。強さページでグラフが横ばいになったら止めてよい。
強化学習なので「必ずこの強さになる」とは言えないが、評価が一番よかった重みは `best.pt` に残る。

> 「ひとり」の評価は 300 手で打ち切るので、最大でも 120 ライン程度。

## 出力（`runs/tetris/<名前>/`）
| ファイル | 中身 |
|---|---|
| `config.json` | 使った設定 |
| `metrics.jsonl` | 1 エピソード 1 行（ライン・火力・loss・ε…） |
| `evals.jsonl` | 250 エピソードごとの評価 |
| `status.json` | 進み具合 |
| `checkpoints/` | `ep_000250.pt` …、`latest.pt`、`best.pt`（評価が一番よかったもの） |

## グラフで見る（強さページ）
1. `python manage.py sync_runs`（学習中なら `--watch 30` で 30 秒ごとに取り込み続ける）
2. ブラウザで `/tetris/stats` を開く（「runs/ から取り込む」ボタンでも取り込める）

比較の基準線（ヒューリスティック AI）を出すには、一度だけ次を実行する:
```powershell
.\.venv\Scripts\python -m rl.tetris.evaluate heuristic --save-run heuristic-baseline
```

## 強さを測る・AI を指定する
```powershell
.\.venv\Scripts\python -m rl.tetris.evaluate runs/tetris/v1/checkpoints/best.pt --games 20
```
画面の AI 選択には `v1:best` `v1:latest` `heuristic` が出る（`apps/tetris_ai/agent_registry.py`）。

## 改良のヒント
- T-Spin を増やしたい: `--reward-attack` を上げる、`encoding.py` に特徴量を足す
- もっと強く: `--hidden 512`、エピソードを増やす、`garbage_end` を上げて対戦向けにする
- 盤面をそのまま入れる CNN にする: `model.py` に別のネットを足し、`encoding.py` で盤面を渡す
