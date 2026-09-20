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
| `env.py` | 学習用の環境。`TetrisEnv`（ランダムなおじゃま）と `VersusEnv`（**自己対戦**） |
| `train.py` | 学習（並列の actor + GPU の learner） |
| `match.py` | **AI 同士の対戦**（オンライン対戦と同じルールで火力を送り合う） |
| `evaluate.py` | 強さを測る（ひとり遊びの平均 + 対戦の勝率） |
| `config.py` | 設定（すべてコマンドラインで上書きできる） |

## 自己対戦で学習する（`--selfplay-start`）
最初はランダムなおじゃまで積み方を覚えさせ、途中から **AI 同士の対戦**に切り替える（既定 3000 エピソード）。

```powershell
.\.venv\Scripts\python -m rl.tetris.train --run-name v2                      # 3000 から自己対戦
.\.venv\Scripts\python -m rl.tetris.train --run-name v2 --selfplay-start 0   # 最初から自己対戦
.\.venv\Scripts\python -m rl.tetris.train --run-name v2 --selfplay-start -1  # 自己対戦なし（前と同じ）

# すでにある重みから始める（特徴量の数が同じなら使える）。積み方は覚えているので、
# すぐ自己対戦に入れて、ランダムに打つ割合も低めから始めるとよい
.\.venv\Scripts\python -m rl.tetris.train --run-name v2 `
    --init-from runs/tetris/trial/checkpoints/best.pt --selfplay-start 0 --eps-start 0.2
```

なぜ必要か: `TetrisEnv` のおじゃまはランダムに降ってくるだけで、**いつ・どれだけ来るかが相手の状況と
つながっていない**。そのため「相手が大きい火力を溜めているから、今は高く積まずに低く構えておく」
という判断は学びようがなかった。実際 `trial` は攻めだけが伸び、おじゃまありの生存率は 0% のままだった。

`VersusEnv` は Game を 2 つ持ち、片方が出した火力をそのまま相手のおじゃまにする（オンライン対戦と同じ）。
どちらも同じ重みで打ち、**両方の側の経験を学習に使う**（1 局で 2 人分たまる）。
先に打つ側がわずかに有利なので、エピソードごとに打つ順番を入れ替える。

`metrics.jsonl` には自己対戦の回だけ `selfplay: true` と `won`（勝ったか）が入る。
`garbage_rate` は、自己対戦では「相手から実際に飛んできた火力（1 手あたり）」になる。

> 注意: 相手の盤面そのものはまだ AI に見せていない（特徴量は自分の盤面だけ）。
> 見せると「相手が溜めているから守る」「相手が高いから畳みかける」を学べるようになる。
> 設計は [docs/TETRIS_OPPONENT_AWARE.md](../../../docs/TETRIS_OPPONENT_AWARE.md)（未実装）。

## 強さの測り方（勝率で測る・best.pt は勝ち抜きで決まる）
評価は 250 エピソードごとに次の 2 つを測る（`evaluate.py`）。

| 種類 | 中身 |
|---|---|
| ひとり遊び `solo` / `pressure` | 決まった seed で 300 手まで遊ばせた平均（ライン・火力・生存率） |
| 対戦 `vs_heuristic` / `vs_best` | AI 同士を戦わせた**勝率**（`match.py`。引き分けは 0.5 勝） |

対戦数は `--versus-games`（既定 20）。**少ないと勝率が運で決まる**ので注意する。6 局だと
「5 勝 1 敗 = 83%」が偶然でも 1 割ほどの確率で出てしまい、強くなっていないのに昇格する。
評価には時間がかかる（1 回 40〜60 秒。250 エピソードの学習が 100 秒ほど）ので、
`--eval-every`（既定 500）とセットで決めること。

**強さの判定は勝率を優先する**（`strength_score`）。ひとり遊びの数値は 300 手の打ち切りで頭打ちになり、
強くなると差が出なくなるため。実際、`trial` は 5,750 エピソードで打ち切り上限に届いたあと、
30,000 エピソード回しても `best.pt` が一度も更新されなかった。

`best.pt` の選び方は `--best-by` で変わる。

| `--best-by` | 選び方 | 使いどころ |
|---|---|---|
| `versus`（既定） | 今の `best.pt` と対戦し、勝率 `--promote-win-rate`（既定 0.55）以上で勝ち越したら差し替える | 対人で強い AI |
| `solo` | ひとり遊びの成績（火力中心）が過去最高なら差し替える。対戦は測らないので評価が速い | **火力特化のモデル**を作るとき |

`versus` は**勝ち抜き方式**で、勝った重みが次の相手になるので、相手も一緒に強くなっていく
（AlphaGo などと同じ考え方）。相手が強くなりすぎて更新が止まったら、そこが今の設計の限界。

**攻め特化と対人型は別の run として両方残すこと**（ブロブチェインの `versus` / `chain` と同じ方針）。
`runs/` は `.gitignore` に入っていて、重みは git に入らない。消すと戻せない。

```powershell
# 対人で強いモデル（自己対戦 + 勝ち抜き）
.\.venv\Scripts\python -m rl.tetris.train --run-name v2-versus --selfplay-start 0 `
    --init-from runs/tetris/trial/checkpoints/best.pt --eps-start 0.2

# 火力特化のモデル（ひとり遊びだけ・おじゃまなし・火力の報酬を上げる）
.\.venv\Scripts\python -m rl.tetris.train --run-name v2-solo --best-by solo `
    --selfplay-start -1 --garbage-end 0 --reward-attack 2.0 --reward-alive 0.02
```

```powershell
# 好きな相手と戦わせて勝率を見る（--vs は何回でも指定できる）
.\.venv\Scripts\python -m rl.tetris.evaluate runs/tetris/v1/checkpoints/best.pt --vs heuristic
.\.venv\Scripts\python -m rl.tetris.evaluate runs/tetris/v2/checkpoints/best.pt --vs runs/tetris/v1/checkpoints/best.pt
```

対戦のルールはオンライン対戦と同じで、固定の結果の `sent`（相殺後の段数）を相手に送る
（`frontend/src/games/tetris/game/versus.ts` と同じ）。両者のツモ順も同じ。実際の対戦は同時に進むが、
`match.py` では 1 手ずつ交互に打つ。先に打つ側がわずかに有利なので、勝率は順番を入れ替えて 2 局ずつ測る。

## 対局での先読み（NEXT を使う）
学習は「今のミノ（とホールド）」だけで手を選ぶが、対局（API・評価）では NEXT のミノも使って先を読む
（`agent.py` の `NeuralAgent(lookahead=…, beam=…)`。学習し直さなくても、同じ重みのまま強くなる）。
- `lookahead=n`: NEXT を n 個先まで読む。各段で点数の高い `beam` 個（既定 8）の局面だけを残して読み進める（ビームサーチ）。
- 対戦画面の AI は `config/settings.py` の `TETRIS_AI_LOOKAHEAD`（**既定 5**。環境変数でも変えられる）を使う。
- ビームサーチなので、1 段深くしても増えるのは「`beam` 個 × 候補手」の評価だけ。深さに比例して増えるだけで、
  指数的には増えない（`lookahead=4` と `6` で 1 手の時間はほとんど変わらない）。
- **5 より深くしても意味がない**。画面に出る NEXT が 5 個（`Game.queue_size`）なので、
  6 手目から先はツモが分からず、そこで読むのをやめるため。実測でも `lookahead=5` と `6` は
  40 局面すべてで同じ手を選んだ（`4` と `5` が違ったのは 40 局面中 1 つ）。
  これ以上深く読ませたいなら、まず NEXT の数を増やす必要がある（人に見える数も変わる）。
- `beam` を広げても強くはならなかった（`beam=24` と `beam=8` を 2 局戦わせて 1 分 1 引き分け。
  1 手の時間は 3 倍）。局数が少ないので断定はできないが、少なくとも割に合わない。
  **先読みの調整では、もう大きくは強くならない**。強くするなら評価関数（重み）のほうを鍛える。
- 評価: `python -m rl.tetris.evaluate <重み> --lookahead 1`

trial の best（5750 エピソード）での比較（10 ゲーム、300 手まで）:

| 先読み | 1 手の時間 | ひとり: 火力 | おじゃまあり: 生き残り | おじゃまあり: 火力 |
|---|---|---|---|---|
| なし | 約 6ms | 100.8 | 30% | 86.6 |
| `lookahead=1`（NEXT 1 個） | 約 55ms | 137.0 | 70% | 151.1 |
| `lookahead=2` | 約 105ms | 152.0 | 100% | 200.5 |
| `lookahead=4` | 約 200ms | 178.2 | 100% | 217.5 |
| `lookahead=5`（**対戦画面の既定**。NEXT を使い切る深さ） | 約 200〜300ms | - | - | - |

1 手あたりの火力は、なし 0.34 → `lookahead=4` で 0.59（おじゃまありでは 0.45 → 0.73）。
1 手 0.2〜0.3 秒かかるので、AI の速さを 3〜4 PPS 以上にすると、考える時間で速さが頭打ちになる。

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
