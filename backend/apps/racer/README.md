# apps/racer/ レースの API

レースそのものはブラウザで動く（`frontend/src/games/racer/`）。サーバーの仕事は 2 つだけで、
**学習した AI の重みを配ること**と、**人の走行結果を残すこと**。
作りはエアホッケー（`apps/airhockey/`）と同じ。

| API | 中身 |
|---|---|
| `GET /api/racer/agents/` | 使える AI の一覧（先頭が既定）。`runs/racer/<学習名>/checkpoints/*.json` を見る |
| `GET /api/racer/agents/<id>/policy/` | 方策の重み（JSON）。ブラウザがこれを読んで自分で計算する |
| `POST /api/racer/results/` | 人の走行結果を保存（コース・車・タイム・順位・トリック・落下） |
| `GET /api/racer/results/summary/` | コースと車ごとのベストタイムと、AI との勝ち負け |

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | 上の 4 つ |
| `serializers.py` | DTO | 入出力の形 |
| `services.py` | Service | `save_result()`: 値の確認と保存、`record_event()` で `/monitor` に出す |
| `selectors.py` | Repository | `summary()`: コース・車ごとの集計 |
| `models.py` | Entity | `RaceResult` |
| `agent_registry.py` | | 学習結果のフォルダから AI の一覧を作る。学習なしより速くなるまでは学習なしを既定にする |

AI の ID は `"<学習名>:best"` / `"<学習名>:latest"`、学習なしの運転者は `"heuristic"`
（ブラウザに組み込み済みなので重みは配らない。`/policy/` を呼ぶと 404）。

コースと車の名前は `shared/courses/` と `shared/cars/` のファイル名がそのまま使われ、
`services.save_result()` が知らない名前をはじく。コースを足せばここも自動でついてくる。
