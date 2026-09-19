# apps/othello/ オセロの API

AI の読み（探索）はブラウザ（Web Worker）で行う。サーバーは **学習した評価関数の重みを配る** のと
**人との対局を記録する** のが役目。設計は [docs/OTHELLO.md](../../../docs/OTHELLO.md)。

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | 評価関数の一覧・パターン定義・重み（バイナリ）・対局の保存・成績 |
| `serializers.py` | DTO | 棋譜の形（`f5d6c3…`）のチェックなど |
| `services.py` | Service | `save_game()`: 棋譜をサーバーのエンジンで最初から再生して確かめてから保存 |
| `selectors.py` | Repository | 最近の対局、AI・強さごとの勝ち負けの集計 |
| `models.py` | Entity | `OthelloGame`（棋譜・人の色・AI・強さ・結果） |
| `agent_registry.py` | | 評価関数の ID ↔ `runs/othello/<run>/checkpoints/{best,latest}.npz`。重みのバイト列をキャッシュ |

評価関数の ID: `positional`（学習なし。ブラウザに組み込み）/ `<学習名>:best` / `<学習名>:latest`。
重みは Float32（リトルエンディアン）を `段階 × TABLE_SIZE` の順に並べたもの（約 4MB）。
