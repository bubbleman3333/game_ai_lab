"""学習結果（runs/<ゲーム>/<学習名>/ のファイル）を取り込んで保存するテーブル。どのゲームでも共通。"""

from django.db import models


class TrainingRun(models.Model):
    game = models.CharField(max_length=30)  # "tetris" / "othello"
    name = models.CharField(max_length=100)
    config = models.JSONField(default=dict)
    status = models.JSONField(default=dict)  # status.json の中身
    # ファイルのどこまで取り込んだか（バイト位置）。次回はその続きから読む
    metrics_offset = models.BigIntegerField(default=0)
    evals_offset = models.BigIntegerField(default=0)
    synced_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["game", "-synced_at"]
        constraints = [models.UniqueConstraint(fields=["game", "name"], name="uniq_game_run")]

    def __str__(self) -> str:
        return f"{self.game}/{self.name}"


class Metric(models.Model):
    """metrics.jsonl の 1 行（1 エピソード / 1 ゲーム）。中身はゲームごとに違うので JSON のまま持つ。"""

    run = models.ForeignKey(TrainingRun, on_delete=models.CASCADE, related_name="metrics")
    episode = models.IntegerField()
    data = models.JSONField(default=dict)

    class Meta:
        ordering = ["episode"]
        constraints = [models.UniqueConstraint(fields=["run", "episode"], name="uniq_run_metric")]


class Evaluation(models.Model):
    """evals.jsonl の 1 行（定期評価）。results の中身はゲームごとに違う。"""

    run = models.ForeignKey(TrainingRun, on_delete=models.CASCADE, related_name="evaluations")
    episode = models.IntegerField()
    step = models.IntegerField(default=0)
    checkpoint = models.CharField(max_length=100)
    score = models.FloatField()
    is_best = models.BooleanField(default=False)
    results = models.JSONField(default=dict)
    evaluated_at = models.DateTimeField(null=True)

    class Meta:
        ordering = ["episode"]
        constraints = [models.UniqueConstraint(fields=["run", "episode"], name="uniq_run_evaluation")]
