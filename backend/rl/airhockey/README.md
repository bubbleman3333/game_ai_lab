# rl/airhockey/ エアホッケー AI の学習（PyTorch・CPU）

物理は `games/airhockey/physics.py`（ブラウザ版 `frontend/src/games/airhockey/engine/physics.ts` と同じ式。
`python -m games.airhockey.fixtures` のテストデータで一致を確認）。

## 学習の流れ
1. **模倣学習**（`--bc-steps`）: 学習なしの AI（パックが自陣なら打ちに行き、なければゴール前で守る）の動きをまねる。
   打ちに行く基本を先に覚えさせる。ゼロから試行錯誤させると「隅に逃げる」だけの AI になりやすかった。
2. **PPO（強化学習）**: 256 面を同時に進めて経験を集め、得点 +1 / 失点 −1 を報酬に方策を良くしていく。
   相手は「過去の自分（25 回ごとのスナップショット）」と「学習なしの AI（速さはランダム）」。
3. AI は 1/30 秒ごとに「マレットを動かしたい向きと速さ」を決める。観測は自分・相手・パックの位置と速度（12 個）。

| ファイル | 中身 |
|---|---|
| `policy.py` | 方策と価値のネット（小さな MLP）、ブラウザ用の JSON 書き出し |
| `env.py` | 学習用の環境（N 面同時・相手の選び方）、評価用の対戦 `play_points` |
| `train.py` | 模倣学習 + PPO |

```powershell
cd backend
.\.venv\Scripts\python -m rl.airhockey.train --run-name v1 --iterations 400
```
i7-11700F で 1 回あたり約 1〜2 秒。400 回で約 15 分。

### 実測
模倣学習のあと PPO 50 回で、学習なしの AI に得点率 100%（速さ 70% の相手にも 99%）。
（模倣学習なしで 300 回回したときは 25〜35% で、ほとんど攻めなかった）

## ブラウザでの動き
方策の重み（JSON、約 300KB）を `GET /api/airhockey/agents/<id>/policy/` で配り、ブラウザで計算する。
学習した AI が学習なしの AI に勝ち越すまでは、学習なしの AI が既定になる（`apps/airhockey/agent_registry.py`）。
