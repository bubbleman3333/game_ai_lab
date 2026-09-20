# apps/blob_ai/ ブロブチェイン AI の API

学習結果の取り込み・表示は [apps/training](../training/README.md)（ゲーム共通）。
オンライン対戦の部屋（`/api/blob/rooms/…`）は [apps/tetris_online](../tetris_online/README.md)。
同じ `/api/blob/` の下に 2 つのアプリが相乗りしている（`config/urls.py`）。

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | `AgentListView` / `MoveView` |
| `serializers.py` | DTO | 局面（`PositionSerializer`）・手の形 |
| `services.py` | Service | `choose_move()`（手を選ぶ） |
| `agent_registry.py` | | AI の ID ↔ 重みファイル（`runs/blob/<run>/checkpoints/*.pt`）。読み込んだ AI をキャッシュ |

AI の先読みの深さは `config/settings.py` の `BLOB_AI_LOOKAHEAD`（既定 2 = NEXT を 2 個先まで読む。
画面に出ている NEXT は 2 つなので、それ以上にしても意味はない。1 手 0.1 秒ほど。0 にすると先読みなし）。
中身は [rl/blob/README.md](../../rl/blob/README.md) の「対局での先読み」。

## GET /api/blob/agents/
使える AI の一覧。先頭が既定（いちばん新しい学習の `best`）。最後に必ず `heuristic` が入る。

学習のスタイル（対戦型 / 連鎖オンリー）は run 名で分かれるだけで、API から見れば同じ。
どちらの重みも同じ `NeuralAgent` が読む。

## POST /api/blob/move/
```json
{
  "position": {
    "rows": ["112233", "112000"],   // 下の行から 6 文字（'0' 空き / '1'〜'4' 色 / '5' おじゃま）
    "current": [1, 2],              // [軸の色, 子の色]
    "next": [[3, 4], [2, 2]],       // NEXT（先読みに使う）
    "pending": 0,                   // 相手から届いて、まだ降っていないおじゃま
    "carry": 0,                     // 70 点に満たずに持ち越している得点
    "all_clear_bonus": false        // 全消し直後か
  },
  "agent": "v1:best"                // 省略すると一番新しい best
}
```
返り値:
```json
{
  "agent": "v1:best", "agent_episode": 5000,
  "placement": {"x": 3, "rot": 1},
  "path": ["CW", "R", "HD"],
  "expected": {"chain": 4, "score": 2280, "sent": 33, "cancelled": 0, "all_clear": false, "dead": false}
}
```
`path` をブラウザのエンジンでそのまま実行すると、AI が選んだ場所に置かれる
（**組が出た直後の位置から**実行すること）。`rows` は行が足りなければ上を空きで埋めて解釈する。

`rows` の形はオンライン対戦の `state` と同じなので、相手の盤面をそのまま AI に渡すこともできる。
