"""レースの走行記録（人が走った結果）。"""

from django.db import models


class RaceResult(models.Model):
    course = models.CharField(max_length=50)  # shared/courses/*.json の id
    car = models.CharField(max_length=50)  # shared/cars/*.json の id
    agent = models.CharField(max_length=100)  # 一緒に走った AI（"なし" ならタイムアタック）
    laps = models.IntegerField()
    total_sec = models.FloatField()
    best_lap_sec = models.FloatField()
    tricks = models.IntegerField(default=0)
    falls = models.IntegerField(default=0)
    place = models.IntegerField(null=True, blank=True)  # AI と走ったときの順位（1 = 勝ち）
    racers = models.IntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
