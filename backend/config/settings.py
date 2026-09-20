"""Django 設定。本番向けの値は環境変数で上書きする（backend/README.md の「公開するとき」参照）。"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes")


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-insecure-key-change-me")
DEBUG = _env_bool("DJANGO_DEBUG", True)
# .trycloudflare.com は Cloudflare のクイックトンネルで公開するとき用
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,.trycloudflare.com").split(",")

INSTALLED_APPS = [
    "daphne",  # runserver を ASGI（WebSocket 対応）にする。django.contrib.staticfiles より前に置く
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "channels",
    "apps.training",
    "apps.tetris_ai",
    "apps.tetris_online",
    "apps.blob_ai",
    "apps.othello",
    "apps.airhockey",
    "apps.racer",
    "apps.shogi",
    "apps.monitoring",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("DJANGO_DB_PATH", BASE_DIR / "db.sqlite3"),
        # WAL: 読んでいる間も書き込みを待たせない。timeout: ロック待ちを長めにする。
        # IMMEDIATE: トランザクションの最初に書き込みの権利を取る。読んでから書く形（select_for_update 等）だと、
        #   途中で他の書き込みが入ったとき SQLite は待たずに "database is locked" を返すため。
        "OPTIONS": {"init_command": "PRAGMA journal_mode=WAL;", "timeout": 20, "transaction_mode": "IMMEDIATE"},
    }
}

# オンライン対戦のメッセージ中継。本番で複数プロセスにするなら REDIS_URL を設定する（channels_redis が必要）。
if os.environ.get("REDIS_URL"):
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [os.environ["REDIS_URL"]]},
        }
    }
else:
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],  # いまはゲスト参加のみ。アカウントを足すときにここを設定する
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_THROTTLE_RATES": {
        "ai_move": os.environ.get("AI_MOVE_RATE", "1200/min"),
        "monitoring": "120/min",
    },
    "EXCEPTION_HANDLER": "config.exceptions.exception_handler",
}

CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5173").split(",")

LANGUAGE_CODE = "ja"
TIME_ZONE = "Asia/Tokyo"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- このプロジェクト独自の設定 -------------------------------------------------
# 学習結果の置き場所（runs/<ゲーム>/<学習名>/。rl/common.py の RUNS_ROOT と同じ場所）
TRAINING_RUNS_DIR = Path(os.environ.get("TRAINING_RUNS_DIR", BASE_DIR / "runs"))
# 学習結果の取り込み API（POST /api/training/sync/）を許可するか。公開時は False にしてコマンドで取り込む
TRAINING_ALLOW_SYNC_API = _env_bool("TRAINING_ALLOW_SYNC_API", DEBUG)
# テトリス AI の手を API で計算するデバイス。1 手ずつの推論は CPU で十分速い
TETRIS_AI_DEVICE = os.environ.get("TETRIS_AI_DEVICE", "cpu")
# テトリス AI の先読み（NEXT を何個先まで読むか。0 なら今のミノだけ）。4 で 1 手 0.2 秒ほど。深いほど強い
# （rl/tetris/README.md の「対局での先読み」）。サーバーが重いときは下げる
TETRIS_AI_LOOKAHEAD = int(os.environ.get("TETRIS_AI_LOOKAHEAD", "4"))
# ブロブチェイン AI（apps/blob_ai）。先読みは画面に出ている NEXT の数ぶん（2）まで意味がある。
# 2 で 1 手 0.1 秒ほど。0 にすると先読みなしで、そのぶん弱いが速い
BLOB_AI_DEVICE = os.environ.get("BLOB_AI_DEVICE", "cpu")
BLOB_AI_LOOKAHEAD = int(os.environ.get("BLOB_AI_LOOKAHEAD", "2"))
# 将棋 AI の探索（MCTS）に使うデバイス。GPU がなければ自動で CPU
SHOGI_AI_DEVICE = os.environ.get("SHOGI_AI_DEVICE", "cuda")

# --- 利用状況・ログ（apps/monitoring） ------------------------------------------------
LOG_DIR = Path(os.environ.get("LOG_DIR", BASE_DIR / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)


def _monitor_token() -> str:
    """監視ページの合言葉。環境変数 MONITOR_TOKEN、なければ backend/.monitor_token（最初に自動で作る）。"""
    if os.environ.get("MONITOR_TOKEN"):
        return os.environ["MONITOR_TOKEN"]
    path = BASE_DIR / ".monitor_token"
    if not path.exists():
        import secrets

        path.write_text(secrets.token_urlsafe(12), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


MONITOR_TOKEN = _monitor_token()

# ログは 1 行 1 件の JSON で、日付ごとにファイルを切り替えて 30 日分残す（Elasticsearch などにそのまま取り込める）
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "apps.monitoring.logging_json.JsonFormatter"}},
    "handlers": {
        "app_file": {
            "class": "logging.handlers.TimedRotatingFileHandler", "filename": str(LOG_DIR / "app.jsonl"),
            "when": "midnight", "backupCount": 30, "encoding": "utf-8", "formatter": "json",
        },
        "events_file": {
            "class": "logging.handlers.TimedRotatingFileHandler", "filename": str(LOG_DIR / "events.jsonl"),
            "when": "midnight", "backupCount": 30, "encoding": "utf-8", "formatter": "json",
        },
        "server_errors": {"class": "apps.monitoring.logging_json.ServerErrorToEvents", "level": "ERROR"},
        "console": {"class": "logging.StreamHandler"},
    },
    "loggers": {
        "django.request": {"handlers": ["app_file", "server_errors", "console"], "level": "WARNING", "propagate": False},
        "game_ai_lab.events": {"handlers": ["events_file"], "level": "INFO", "propagate": False},
        "apps": {"handlers": ["app_file", "console"], "level": "INFO"},
    },
}
