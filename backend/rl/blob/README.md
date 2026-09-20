# rl/blob/ ブロブチェインの強化学習（PyTorch）

## 何を学習しているか
テトリス（`rl/tetris/`）と同じ「置いた後の盤面の価値 V」を学ぶやり方。

1. 今の組ぷよの置き場所を全部出す（列 6 × 向き 4 のうち、届くものだけ。ふつう 19〜22 通り）
2. 置いて**連鎖が止まるまで**進めた盤面を特徴量ベクトル（41 次元、`encoding.py`）にする
3. `報酬 + γ × V(置いた後)` が最大の手を選ぶ（学習中は確率 ε でランダム）
4. 経験 `(a_t, r, a_{t+1}, 終了か)` を貯め、`V(a_t) ≒ r + γ V_target(a_{t+1})` になるよう重みを更新する
   （DQN と同じ工夫: リプレイバッファ・ターゲットネット）

γ は 0.98（テトリスの 0.97 より大きい）。連鎖は 10 手以上かけて組むので、そのぶん先を見る必要がある。

## 2 つのスタイル（`--reward-preset`）
**同じネット・同じ学習コードで、報酬の付け方だけを変えた 2 種類**の AI を作れる。
学習すると別々の run になるので、対戦画面の AI 選択に両方が並ぶ（`v1-versus:best` と `v1-chain:best` のように）。

| | `versus`（対戦型） | `chain`（連鎖オンリー） |
|---|---|---|
| 目的 | **対戦に勝つ** | **大連鎖を組む** |
| 報酬 | 相手に送ったおじゃまの数 | 連鎖数の 2 乗。おじゃまの数は見ない |
| 早撃ちの罰 | なし | 5 連鎖未満で撃つと −1.0 |
| 学習中のおじゃま | あり（1 組につき平均 0.6 個） | なし（崩されると組む練習にならない） |
| `best.pt` の選び方 | 送ったおじゃま + 生存率 | 大連鎖の回数・発火の平均段数 |
| 向いている場面 | 対戦画面、オンライン対戦の練習 | 大連鎖を眺める、人のお手本 |

```powershell
.\.venv\Scripts\python -m rl.blob.train --run-name v1-versus --reward-preset versus
.\.venv\Scripts\python -m rl.blob.train --run-name v1-chain  --reward-preset chain
```
個別の `--reward-attack 0.2` などを付けると、スタイルの値を部分的に上書きできる。
`--garbage-end 0.3` のようにおじゃまの量も上書きできるので、「連鎖を組みつつ対戦もこなす」中間型も作れる。

### なぜ早撃ちの罰が要るか
おじゃまの数は連鎖数に対してねずみ算式に増える（3 連鎖 14 個 → 6 連鎖 124 個 → 9 連鎖 398 個）ので、
大連鎖の得は放っておいても十分にある。それでも AI が小さく撃ってしまうのは、
**組みかけを壊すことに損がない**から。1 連鎖は 40 点 = おじゃま 0 個で、報酬の上では「ただ消えただけ」に見える。
実測でも、学習なしのヒューリスティック AI は 1 局に 31 回も発火していて、平均はわずか 2.51 連鎖だった。
そこで 5 連鎖未満の発火に罰を与え、「今はまだ撃たない」を覚えさせている。これが `chain` 型の肝。

### 特徴量でいちばん大事なもの
**`potential_chain`**（`encoding.py` の `chain_potential`）= 「あと 1 個どこかに置いたら、最大で何連鎖するか」。

連鎖を組んでいる途中の盤面は、得点や消した数では「よい形かどうか」が測れない
（大連鎖の一歩手前でも、まだ 0 点）。そこで、落とす粒の色を隣の色に絞って全部試し、
一番長い連鎖の段数と得点を特徴量として渡している。ここがあるかないかで強さがまるで変わる。

| ファイル | 中身 |
|---|---|
| `position.py` | 局面 `Position` と、候補手の列挙 `enumerate_candidates()` |
| `encoding.py` | 候補 → 特徴量ベクトル（**変えたら `FEATURE_VERSION` を上げる**）・`chain_potential` |
| `model.py` | `ValueNet`（MLP）と重みの保存・読み込み |
| `agent.py` | `NeuralAgent`（学習した AI）・`HeuristicAgent`（比較用。固定の重み） |
| `env.py` | 学習用の環境（ランダムなおじゃまを送ってくる相手の代わり） |
| `train.py` | 学習（並列の actor + GPU の learner） |
| `evaluate.py` | 決まった seed で遊ばせて強さを測る |
| `config.py` | 設定（すべてコマンドラインで上書きできる） |

ルールそのものは `backend/games/blob/`（TypeScript 版と一致することを
`shared/fixtures/blob/engine_cases.json` で確かめている）。

## 候補手について
- 置き方は「回転してから左右に動かす」で表す。実際に組を動かして届くか確かめているので
  （`games/blob/game.py` の `path_to`）、高く積んで通れない列は候補に出てこない。
- 結果が同じになる置き方（同じ色の組の「子が上」と「子が下」など）はまとめて 1 つにする。
- 予告のおじゃまが降るぶんは**見込まない**（降り方が乱数のため）。代わりに、残っている予告の数を
  特徴量として渡している。

## 対局での先読み（NEXT を使う）
学習は「今の組」だけで手を選ぶが、対局（API・評価）では NEXT の組も使って先を読む
（`agent.py` の `NeuralAgent(lookahead=…, beam=…)`。学習し直さなくても、同じ重みのまま強くなる）。
画面に出ている NEXT は 2 つなので、`lookahead` は 2 まで意味がある。
対戦画面の AI は `config/settings.py` の `BLOB_AI_LOOKAHEAD`（既定 2、環境変数でも変えられる）を使う。

## 学習する
```powershell
cd backend
.\.venv\Scripts\python -m rl.blob.train --run-name v1-versus --reward-preset versus  # 対戦型
.\.venv\Scripts\python -m rl.blob.train --run-name v1-chain  --reward-preset chain   # 連鎖オンリー（既定）
.\.venv\Scripts\python -m rl.blob.train --run-name v1-chain --resume                 # 中断した続きから
.\.venv\Scripts\python -m rl.blob.train --help                                       # 設定の一覧
```
2 つは別々の run になるので、**両方そのまま残って両方選べる**。順番に流してよい。
- Ctrl+C で止めても `latest.pt` は保存される。
- `--workers 5`〜`6`: その数のプロセスが並列にゲームを遊び、GPU で学習する。CPU のコア数に合わせて調整。
- `--workers 0`: 1 プロセスだけで動く。PyCharm のデバッガで追うときはこちら。
- 1 手を考えるのに 5ms ほどかかる（候補ごとに連鎖の見積りをするため）。上限 400 組のゲームで
  1 エピソード 1〜2 秒が目安。既定の 20000 エピソードは **数時間**かかる。

## 出力（`runs/blob/<名前>/`）
| ファイル | 中身 |
|---|---|
| `config.json` | 使った設定 |
| `metrics.jsonl` | 1 エピソード 1 行（置いた組・送ったおじゃま・最大連鎖・loss・ε…） |
| `evals.jsonl` | 250 エピソードごとの評価 |
| `status.json` | 進み具合 |
| `checkpoints/` | `ep_000250.pt` …、`latest.pt`、`best.pt`（評価が一番よかったもの） |

## グラフで見る（強さページ）
1. `python manage.py sync_runs`（学習中なら `--watch 30` で 30 秒ごとに取り込み続ける）
2. ブラウザで `/blob/stats` を開く（「最新にする」ボタンでも取り込める）

比較の基準線（ヒューリスティック AI）を出すには、一度だけ次を実行する:
```powershell
.\.venv\Scripts\python -m rl.blob.evaluate heuristic --save-run heuristic-baseline
```

### 目安の成績
ヒューリスティック AI（学習なし。10 ゲーム、200 組まで）:

| モード | 置いた組 | 平均の最大連鎖 | 発火の平均段数 | 大連鎖/局 | 早撃ち/局 | 発火回数/局 | 送ったおじゃま | 生存率 |
|---|---|---|---|---|---|---|---|---|
| ひとり | 200（打ち切り） | 6.3 | 2.51 | 1.0 | 18.5 | 31.5 | 982.6 | 100% |
| おじゃまあり | 97.3 | 4.8 | 1.99 | 0.4 | 12.4 | 16.4 | 260.3 | 0% |

**最大連鎖が 6.3 なのは、たまたま繋がった 1 回**というだけ。ふだんは 1 局に 31 回も発火していて、
平均はわずか 2.51 連鎖（うち 18.5 回は 2 連鎖以下）。連鎖の組み方を見るときは
「最大連鎖」ではなく**「発火の平均段数」と「大連鎖/局」**を見ること。

`chain` 型を 1500 エピソードだけ学習させた時点（参考値。ひとりモード）:

| | 平均の最大連鎖 | 発火の平均段数 | 大連鎖/局 |
|---|---|---|---|
| ヒューリスティック（学習なし） | 6.3 | 2.51 | 1.0 |
| `chain` 型 1500 エピソード | 7.5 | 3.6 | 3.5 |

たった 1500 エピソード（9 分）でこの差が出る。既定の 20000 エピソードならもっと伸びる見込み。

「おじゃまあり」の評価は厳しめに作ってある（200 組まで生き残れた AI はまだない）。
とくに `chain` 型はおじゃま無しで学習するので、おじゃまありの成績は低く出る（設計どおり）。

## 強さを測る・AI を指定する
```powershell
.\.venv\Scripts\python -m rl.blob.evaluate runs/blob/v1-chain/checkpoints/best.pt --games 20 --lookahead 1
.\.venv\Scripts\python -m rl.blob.evaluate runs/blob/v1-versus/checkpoints/best.pt --style versus
```
`--style` は「良さ」の測り方（`chain` = 連鎖の組み方、`versus` = 対戦の強さ）。学習中の `best.pt` 選びには
その run のスタイルが自動で使われるので、ふだんは指定しなくてよい。

画面の AI 選択には `v1-chain:best` `v1-versus:best` `heuristic` などが出る（`apps/blob_ai/agent_registry.py`）。

## 改良のヒント
- 連鎖をもっと伸ばしたい: `--reward-min_chain 7`（我慢のしきい値を上げる）、`--gamma 0.99`
- もっと強く: `--hidden 512`、エピソードを増やす
- 中間型が欲しい: `--reward-preset chain --reward-attack 0.06 --garbage-end 0.3`
- 相殺の判断を覚えさせたい: `encoding.py` に「予告が降るまでに何手あるか」を足す
- 盤面をそのまま入れる CNN にする: `model.py` に別のネットを足し、`encoding.py` で盤面を渡す
