"""学習結果 API の入出力の形。"""

from rest_framework import serializers

from .models import Evaluation, TrainingRun


class TrainingRunSerializer(serializers.ModelSerializer):
    class Meta:
        model = TrainingRun
        fields = ["game", "name", "config", "status", "synced_at"]


class EvaluationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Evaluation
        fields = ["episode", "step", "checkpoint", "score", "is_best", "results", "evaluated_at"]


class MetricBucketSerializer(serializers.Serializer):
    episode = serializers.IntegerField()
    step = serializers.IntegerField()
    episodes = serializers.IntegerField()
    avg = serializers.DictField(child=serializers.FloatField())
    max = serializers.DictField(child=serializers.FloatField())


class SyncResultSerializer(serializers.Serializer):
    game = serializers.CharField()
    run = serializers.CharField()
    new_metrics = serializers.IntegerField()
    new_evaluations = serializers.IntegerField()
