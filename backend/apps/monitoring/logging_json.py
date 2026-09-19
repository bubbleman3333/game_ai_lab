"""ログを 1 行 1 件の JSON で書く（Elasticsearch / Kibana などにそのまま取り込める形）。
サーバーのエラーは、DB の出来事一覧（監視ページ）にも入れる。"""

import json
import logging
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        row = {
            "@timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        event = getattr(record, "event", None)
        if isinstance(event, dict):
            row.update(event)
        if record.exc_info:
            row["exception"] = self.formatException(record.exc_info)
        return json.dumps(row, ensure_ascii=False, default=str)


class ServerErrorToEvents(logging.Handler):
    """django.request の ERROR（500 エラー）を監視ページの出来事にも出す。"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            from .models import Event
            from .services import record_event

            request = getattr(record, "request", None)
            path = getattr(request, "path", "")
            record_event(Event.Kind.SERVER_ERROR, record.getMessage()[:300], data={"path": path})
        except Exception:  # noqa: BLE001  ログの処理で失敗しても何もしない
            pass
