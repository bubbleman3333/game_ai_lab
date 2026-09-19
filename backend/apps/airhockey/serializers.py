from rest_framework import serializers


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()


class MatchCreateSerializer(serializers.Serializer):
    agent = serializers.CharField(max_length=100)
    level = serializers.CharField(max_length=20)
    human_score = serializers.IntegerField(min_value=0)
    ai_score = serializers.IntegerField(min_value=0)
    duration_sec = serializers.FloatField(min_value=0, default=0)


class SummaryRowSerializer(serializers.Serializer):
    agent = serializers.CharField()
    level = serializers.CharField()
    games = serializers.IntegerField()
    human_wins = serializers.IntegerField()
    human_losses = serializers.IntegerField()
    human_points = serializers.IntegerField()
    ai_points = serializers.IntegerField()
