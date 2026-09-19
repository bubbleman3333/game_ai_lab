"""API の入出力の形（DTO）。入力の検証もここで行う。"""

from rest_framework import serializers

from games.tetris import BOARD_HEIGHT, PIECE_TYPES

PIECE_CHOICES = list(PIECE_TYPES)


class PositionSerializer(serializers.Serializer):
    """AI に渡す局面。rows は下の行から順に 10bit 整数（docs/RULES.md）。"""

    rows = serializers.ListField(child=serializers.IntegerField(min_value=0, max_value=1023),
                                 min_length=1, max_length=BOARD_HEIGHT)
    current = serializers.ChoiceField(choices=PIECE_CHOICES)
    hold = serializers.ChoiceField(choices=PIECE_CHOICES, allow_null=True, required=False, default=None)
    can_hold = serializers.BooleanField(default=True)
    next = serializers.ListField(child=serializers.ChoiceField(choices=PIECE_CHOICES), max_length=7, default=list)
    combo = serializers.IntegerField(min_value=-1, default=-1)
    b2b = serializers.BooleanField(default=False)
    pending = serializers.ListField(
        child=serializers.ListField(child=serializers.IntegerField(min_value=0), min_length=2, max_length=2),
        default=list, max_length=20,
    )

    def validate_rows(self, rows: list[int]) -> list[int]:
        return rows + [0] * (BOARD_HEIGHT - len(rows))


class MoveRequestSerializer(serializers.Serializer):
    position = PositionSerializer()
    agent = serializers.CharField(required=False, allow_blank=True, default="")


class PlacementSerializer(serializers.Serializer):
    piece = serializers.CharField()
    rot = serializers.IntegerField()
    x = serializers.IntegerField()
    y = serializers.IntegerField()
    spin = serializers.CharField()
    path = serializers.ListField(child=serializers.CharField())


class MoveResponseSerializer(serializers.Serializer):
    agent = serializers.CharField()
    agent_episode = serializers.IntegerField(allow_null=True, help_text="何エピソード目まで学習した重みか（学習が進むと自動で新しくなる）")
    use_hold = serializers.BooleanField()
    placement = PlacementSerializer()
    path = serializers.ListField(child=serializers.CharField(), help_text="HOLD を含む、HD までの操作列")
    expected = serializers.DictField()


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()
