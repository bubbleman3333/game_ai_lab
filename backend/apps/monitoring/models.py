"""利用状況（今誰が遊んでいるか）と出来事のログ。IP アドレスは保存しない。"""

from django.db import models


class Presence(models.Model):
    """開いている画面 1 つ（ブラウザのタブ 1 つ）。15 秒ごとの合図で last_seen を更新する。"""

    session_id = models.CharField(max_length=64, unique=True)  # タブごとのランダムな ID
    path = models.CharField(max_length=200)
    game = models.CharField(max_length=30, blank=True)
    device = models.CharField(max_length=10)  # mobile / desktop
    nickname = models.CharField(max_length=20, blank=True)
    first_seen = models.DateTimeField(auto_now_add=True)
    last_seen = models.DateTimeField(db_index=True)


class Event(models.Model):
    """対局の結果、利用者の画面のエラー、サーバーのエラーなど。"""

    class Kind(models.TextChoices):
        GAME = "game", "対局"
        CLIENT_ERROR = "client_error", "画面のエラー"
        SERVER_ERROR = "server_error", "サーバーのエラー"

    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    kind = models.CharField(max_length=20, choices=Kind.choices)
    game = models.CharField(max_length=30, blank=True)
    message = models.CharField(max_length=300)
    data = models.JSONField(default=dict, blank=True)
    session_id = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ["-created_at"]
