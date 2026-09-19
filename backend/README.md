# backend（Django + DRF + Channels）

## セットアップ
```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements-dev.txt
.\.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu128   # GPU 版
.\.venv\Scripts\python manage.py migrate
.\.venv\Scripts\python manage.py runserver 8000
```
`runserver` は daphne（ASGI）で起動するので、WebSocket もそのまま使える。

PyCharm: `backend/.venv/Scripts/python.exe` をインタープリタにし、`backend` を Sources Root にする。

## 中身
| 場所 | 役割 | README |
|---|---|---|
| `games/tetris/` | テトリスのルールエンジン（Django 非依存） | [games/tetris/README.md](games/tetris/README.md) |
| `games/othello/` | オセロのルールエンジン（Django 非依存） | [../docs/OTHELLO.md](../docs/OTHELLO.md) |
| `rl/tetris/` | テトリスの強化学習（PyTorch） | [rl/tetris/README.md](rl/tetris/README.md) |
| `rl/othello/` | オセロの評価関数の学習（numpy） | [rl/othello/README.md](rl/othello/README.md) |
| `rl/common.py` | 学習結果の置き場所（`runs/<ゲーム>/<学習名>/`）など | |
| `apps/training/` | 学習結果の取り込み・強さページ用 API（ゲーム共通） | [apps/training/README.md](apps/training/README.md) |
| `apps/tetris_ai/` | テトリス AI の手を返す API | [apps/tetris_ai/README.md](apps/tetris_ai/README.md) |
| `apps/tetris_online/` | テトリスのオンライン対戦（部屋の REST + 対戦の WebSocket） | [apps/tetris_online/README.md](apps/tetris_online/README.md) |
| `apps/othello/` | オセロの評価関数の配信・棋譜の保存 | [apps/othello/README.md](apps/othello/README.md) |
| `apps/common/` | 共通のエラー型 | |
| `config/` | 設定・URL・ASGI・エラー応答の形 | |
| `tests/<ゲーム>/` | pytest | |

## 層の分け方（Controller → Service → Repository との対応）
DRF の慣習（HackSoft の Django Styleguide でよく使われる形）に合わせている。

| よくある呼び方 | このプロジェクト | 役割 |
|---|---|---|
| Controller | `views.py` / `consumers.py` | 入力を serializer で検証し、service / selector を呼び、serializer で返す。業務処理は書かない |
| DTO | `serializers.py` | API の入出力の形と入力チェック |
| Service | `services.py` | 書き込み・業務処理。トランザクションはここで張る |
| Repository（読み取り） | `selectors.py` | DB の読み取りだけ |
| Entity | `models.py` | Django ORM のモデル（ORM が Repository の書き込み側も兼ねる） |

- service が投げた `apps.common.errors.DomainError` は、`config/exceptions.py` が
  `{"error": {"code", "message", "detail"}}` の形の HTTP 応答に変える。view で try/except しなくてよい。
- エラー応答はすべてこの形にそろえている（DRF の入力エラーも同じ形）。

## API 一覧
| メソッド | URL | 内容 |
|---|---|---|
| GET | `/api/health/` | 動作確認 |
| GET | `/api/training/runs/?game=tetris` | 学習の一覧 |
| GET | `/api/training/runs/<game>/<name>/metrics/?bucket=50` | 学習の推移 |
| GET | `/api/training/runs/<game>/<name>/evaluations/` | 評価の推移 |
| POST | `/api/training/sync/` | `runs/` を DB に取り込む（開発用） |
| GET | `/api/tetris/agents/` | テトリス AI の一覧 |
| POST | `/api/tetris/move/` | 局面を送るとテトリス AI の手を返す |
| POST/GET | `/api/tetris/rooms/` | 部屋を作る / 待っている部屋の一覧 |
| GET | `/api/tetris/rooms/<code>/` | 部屋の詳細 |
| WS | `/ws/tetris/rooms/<code>/?name=<名前>` | テトリスの対戦（`apps/tetris_online/protocol.py`） |
| GET | `/api/othello/agents/` | オセロの評価関数の一覧 |
| GET | `/api/othello/spec/` | パターン定義 |
| GET | `/api/othello/agents/<id>/weights/` | 学習した重み（バイナリ） |
| POST/GET | `/api/othello/games/` | 人と AI の対局を保存 / 最近の対局 |
| GET | `/api/othello/games/summary/` | AI・強さごとの人の勝ち負け |

## 公開するとき（環境変数）
| 変数 | 例 | 説明 |
|---|---|---|
| `DJANGO_SECRET_KEY` | 長いランダム文字列 | 必ず変える |
| `DJANGO_DEBUG` | `false` | |
| `DJANGO_ALLOWED_HOSTS` | `example.com` | カンマ区切り |
| `CORS_ALLOWED_ORIGINS` | `https://example.com` | フロントを別ドメインに置く場合 |
| `REDIS_URL` | `redis://...` | 複数プロセスで動かすとき（`pip install channels_redis`） |
| `TRAINING_ALLOW_SYNC_API` | `false` | 取り込み API を閉じる（`manage.py sync_runs` を使う） |
| `TRAINING_RUNS_DIR` | | 学習結果の置き場所（既定 `backend/runs`） |
| `AI_MOVE_RATE` | `1200/min` | テトリス AI API の回数制限（IP ごと） |
| `DJANGO_DB_PATH` | | SQLite の場所。PostgreSQL にするなら `settings.DATABASES` を変える |

起動は `daphne config.asgi:application`。学習済みの重み（`runs/tetris/<名前>/checkpoints/best.pt`、`runs/othello/<名前>/checkpoints/best.npz`）もサーバーに置く。
オンライン対戦は各ブラウザが盤面を計算し、サーバーは中継と勝敗記録だけをする（不正対策はしていない）。
