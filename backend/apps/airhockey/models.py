"""人と AI のエアホッケーの試合結果。"""

from django.db import models


class AirHockeyMatch(models.Model):
    agent = models.CharField(max_length=100)  # "v1:best" / "heuristic"
    level = models.CharField(max_length=20)  # AI の速さ（画面の選択肢）
    human_score = models.IntegerField()
    ai_score = models.IntegerField()
    duration_sec = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
