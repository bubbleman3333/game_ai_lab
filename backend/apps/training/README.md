# apps/training/ 学習結果（ゲーム共通）

学習スクリプト（`rl/<ゲーム>/train.py`）は `runs/<ゲーム>/<学習名>/` に次のファイルを書く。
ここはそれを DB に取り込み、強さページ（`frontend/src/components/TrainingStats.tsx`）に渡す。

| ファイル | 中身 |
|---|---|
| `config.json` | 学習の設定 |
| `status.json` | 進み具合（`state` `episode` `episodes` `elapsed_sec` …） |
| `metrics.jsonl` | 1 エピソード（1 局）1 行。`episode` は必須。ほかの項目は自由（数値・真偽値はグラフにできる） |
| `evals.jsonl` | 定期評価 1 回 1 行。`episode` `score` `is_best` `checkpoint` `results`（中身は自由） |

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | 学習の一覧・詳細・推移・評価、取り込み |
| `serializers.py` | DTO | |
| `services.py` | Service | `sync_all_runs()`: 前回読んだバイト位置の続きから jsonl を読んで DB に入れる |
| `selectors.py` | Repository | `metric_buckets()`: エピソードを N 個ずつまとめて平均・最大を出す（項目はゲーム次第） |
| `models.py` | Entity | `TrainingRun`（game + name）・`Metric`（JSON）・`Evaluation`（JSON） |
| `management/commands/sync_runs.py` | | `python manage.py sync_runs [--watch 秒]` |

学習中に何度取り込んでもよい（書きかけの最終行は次回に回す）。
