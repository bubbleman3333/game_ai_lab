"""人と AI の将棋の対局。指し手は USI 形式で空白区切り（例 "7g7f 3c3d"）。"""

from django.db import models


class ShogiGame(models.Model):
    class Color(models.TextChoices):
        BLACK = "black", "先手"
        WHITE = "white", "後手"

    class Result(models.TextChoices):
        HUMAN_WIN = "human_win", "人の勝ち"
        AI_WIN = "ai_win", "AI の勝ち"
        DRAW = "draw", "引き分け"

    human_color = models.CharField(max_length=5, choices=Color.choices)
    agent = models.CharField(max_length=100)
    level = models.CharField(max_length=20)
    moves = models.TextField(blank=True, default="")
    result = models.CharField(max_length=10, choices=Result.choices, blank=True, default="")
    reason = models.CharField(max_length=50, blank=True, default="")  # 投了・詰み・千日手 など
    last_ai = models.JSONField(default=dict, blank=True)  # 直前の AI の読み（勝率・読み筋）
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def move_list(self) -> list[str]:
        return self.moves.split() if self.moves else []
