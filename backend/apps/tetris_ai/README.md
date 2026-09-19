# apps/tetris_ai/ テトリス AI の API

学習結果の取り込み・表示は [apps/training](../training/README.md)（ゲーム共通）。

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | `AgentListView` / `MoveView` |
| `serializers.py` | DTO | 局面（`PositionSerializer`）・手の形 |
| `services.py` | Service | `choose_move()`（手を選ぶ） |
| `agent_registry.py` | | AI の ID ↔ 重みファイル（`runs/tetris/<run>/checkpoints/*.pt`）。読み込んだ AI をキャッシュ |

AI の先読みの深さは `config/settings.py` の `TETRIS_AI_LOOKAHEAD`（既定 4 = NEXT を 4 個先まで読む。1 手 0.2 秒ほど。
0 にすると先読みなし）。中身は [rl/tetris/README.md](../../rl/tetris/README.md) の「対局での先読み」。

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
