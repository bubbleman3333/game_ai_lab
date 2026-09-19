from django.contrib import admin

from .models import Evaluation, TrainingRun


@admin.register(TrainingRun)
class TrainingRunAdmin(admin.ModelAdmin):
    list_display = ["game", "name", "synced_at"]
    list_filter = ["game"]


@admin.register(Evaluation)
class EvaluationAdmin(admin.ModelAdmin):
    list_display = ["run", "episode", "checkpoint", "score", "is_best"]
    list_filter = ["run__game"]
