from rest_framework import serializers

from .models import ShogiGame
from .services import LEVELS


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()


class StartSerializer(serializers.Serializer):
    human_color = serializers.ChoiceField(choices=ShogiGame.Color.choices)
    agent = serializers.CharField(max_length=100)
    level = serializers.ChoiceField(choices=list(LEVELS))


class MoveSerializer(serializers.Serializer):
    move = serializers.RegexField(r"^([1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$", help_text="USI 形式（7g7f, P*5e など）")


class SummaryRowSerializer(serializers.Serializer):
    agent = serializers.CharField()
    level = serializers.CharField()
    games = serializers.IntegerField()
    human_wins = serializers.IntegerField()
    human_losses = serializers.IntegerField()
    draws = serializers.IntegerField()
