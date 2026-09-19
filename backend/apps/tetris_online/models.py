"""オンライン対戦の部屋・参加者・結果。テトリスとブロブチェインで共通（Room.game で区別する）。"""

from django.db import models


class Room(models.Model):
    class Status(models.TextChoices):
        WAITING = "waiting", "待機中"  # 2 人そろって両者 ready になるのを待っている
        PLAYING = "playing", "対戦中"

    game = models.CharField(max_length=20, default="tetris")  # "tetris" / "blob"
    code = models.CharField(max_length=8, unique=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.WAITING)
    seed = models.BigIntegerField(default=0)  # 対戦ごとに変わる。両者同じツモ順になる
    round = models.IntegerField(default=0)  # 何戦目か
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.code


class RoomPlayer(models.Model):
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="players")
    slot = models.IntegerField()  # 0 or 1
    name = models.CharField(max_length=20)
    channel_name = models.CharField(max_length=200)  # WebSocket 接続の ID
    ready = models.BooleanField(default=False)
    alive = models.BooleanField(default=True)
    wins = models.IntegerField(default=0)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["slot"]
        constraints = [models.UniqueConstraint(fields=["room", "slot"], name="uniq_room_slot")]


class MatchResult(models.Model):
    class Reason(models.TextChoices):
        TOPOUT = "topout", "相手がゲームオーバー"
        DISCONNECT = "disconnect", "相手が切断"

    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="results")
    round = models.IntegerField()
    winner_name = models.CharField(max_length=20)
    loser_name = models.CharField(max_length=20)
    winner_slot = models.IntegerField()
    reason = models.CharField(max_length=12, choices=Reason.choices)
    duration_sec = models.FloatField(default=0)
    stats = models.JSONField(default=dict)  # {slot: クライアントが送った成績}
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
