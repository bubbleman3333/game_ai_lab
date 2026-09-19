"""人と AI の対局の記録（棋譜）。AI の強さを人間相手の成績でも見るために残す。"""

from django.db import models


class OthelloGame(models.Model):
    class Color(models.TextChoices):
        BLACK = "black", "黒（先手）"
        WHITE = "white", "白（後手）"

    moves = models.CharField(max_length=128)  # "f5d6c3..."（パスは書かない）
    human_color = models.CharField(max_length=5, choices=Color.choices)
    agent = models.CharField(max_length=100)  # 使った評価関数（"v1:best" / "positional"）
    level = models.CharField(max_length=20)  # 読みの強さ（画面の選択肢）
    black_discs = models.IntegerField()
    white_discs = models.IntegerField()
    human_result = models.IntegerField()  # 人から見た石差（空きマスは勝った側に数える）
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
