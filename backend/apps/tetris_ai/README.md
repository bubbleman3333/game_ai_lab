# apps/tetris_ai/ テトリス AI の API

学習結果の取り込み・表示は [apps/training](../training/README.md)（ゲーム共通）。

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | `AgentListView` / `MoveView` |
| `serializers.py` | DTO | 局面（`PositionSerializer`）・手の形 |
| `services.py` | Service | `choose_move()`（手を選ぶ） |
| `agent_registry.py` | | AI の ID ↔ 重みファイル（`runs/tetris/<run>/checkpoints/*.pt`）。読み込んだ AI をキャッシュ |

## 既定の AI をどれにするか

`agent` を省略したときに使う AI は、次の順で決まる。

1. `runs/tetris/default_agent.txt`（1 行に AI の ID）があれば、それ
2. なければ「いちばん新しい `best.pt`」。ただし **`MIN_DEFAULT_EPISODES`（3000）に満たない
   学習は選ばない**（学習を 2 つ同時に回すと、始めたばかりのほぼランダムな run が
   いちばん新しくなってしまうため）

**2 は強さを見ていない。** どの重みが強いかはエピソード数でもファイルの新しさでも決まらない。
実際、総当たり戦（各組 20 局）ではこうなった:

| 順位 | AI | 勝率の合計 | エピソード |
|---|---|---|---|
| 1 | `v3-selfplay` | 2.12 / 3.00 | 7,630 |
| 2 | `trial` | 1.85 | 35,750 |
| 3 | `v5-opponent` | 1.65 | 5,900 |
| 4 | ヒューリスティック | 0.38 | — |

エピソード数が 4 倍以上ある `trial` より `v3-selfplay` のほうが強い。
**強いものを出したいなら、総当たりで確かめて `default_agent.txt` に書くこと。**
`runs/` は .gitignore なので、この指定は PC ごとの設定になる。

```powershell
# 総当たりの測り方（rl/tetris/match.py）
.\.venv\Scripts\python -m rl.tetris.evaluate runs/tetris/A/checkpoints/best.pt `
    --vs runs/tetris/B/checkpoints/best.pt --vs-games 20
```

AI の先読みの深さは `config/settings.py` の `TETRIS_AI_LOOKAHEAD`（既定 5 = NEXT を 5 個先まで読む。1 手 0.2〜0.3 秒ほど。
0 にすると先読みなし）。画面の NEXT が 5 個なので、5 より大きくしても手は変わらない。
中身は [rl/tetris/README.md](../../rl/tetris/README.md) の「対局での先読み」。

## POST /api/tetris/move/
```json
{
  "position": {
    "rows": [1023, 511, 0],          // 下の行から 10bit 整数（足りない分は 0 で埋める）
    "current": "T", "hold": null, "can_hold": true,
    "next": ["I", "O", "S"], "combo": -1, "b2b": false,
    "pending": [[3, 5]]              // [段数, 穴の列]
  },
  "agent": "v1:best"                 // 省略すると一番新しい best
}
```
返り値の `path`（例 `["L", "L", "CW", "SDB", "HD"]`）をブラウザのエンジンでそのまま実行すると、
AI が選んだ場所に置かれる（出現した直後の位置から実行すること）。
