"""オセロ API の入出力の形。"""

import re

from rest_framework import serializers

from .models import OthelloGame


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()


class GameCreateSerializer(serializers.Serializer):
    moves = serializers.CharField(max_length=128)
    human_color = serializers.ChoiceField(choices=OthelloGame.Color.choices)
    agent = serializers.CharField(max_length=100)
    level = serializers.CharField(max_length=20)

    def validate_moves(self, v: str) -> str:
        v = v.lower()
        if not re.fullmatch(r"([a-h][1-8])+", v):
            raise serializers.ValidationError("a1〜h8 の手を続けて書いてください（例: f5d6c3）")
        return v


class GameSerializer(serializers.ModelSerializer):
    class Meta:
        model = OthelloGame
        fields = ["id", "moves", "human_color", "agent", "level", "black_discs", "white_discs",
                  "human_result", "created_at"]


class SummaryRowSerializer(serializers.Serializer):
    agent = serializers.CharField()
    level = serializers.CharField()
    games = serializers.IntegerField()
    human_wins = serializers.IntegerField()
    human_losses = serializers.IntegerField()
    draws = serializers.IntegerField()
