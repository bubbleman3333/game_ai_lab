"""API の入出力の形（DTO）。入力の検証もここで行う。"""

import re

from rest_framework import serializers

from games.blob import COLORS, H, W

_ROW = re.compile(rf"^[0-{COLORS}5]{{{W}}}$")  # '0' 空き / '1'〜'4' 色 / '5' おじゃま


class PairSerializer(serializers.ListField):
    """組ぷよ [軸の色, 子の色]（どちらも 1〜4）。"""

    def __init__(self, **kw):
        super().__init__(child=serializers.IntegerField(min_value=1, max_value=COLORS),
                         min_length=2, max_length=2, **kw)


class PositionSerializer(serializers.Serializer):
    """AI に渡す局面。rows は下の行から 1 行 6 文字（オンライン対戦の rows と同じ形）。"""

    rows = serializers.ListField(child=serializers.RegexField(_ROW), min_length=1, max_length=H)
    current = PairSerializer()
    next = serializers.ListField(child=PairSerializer(), max_length=4, default=list)
    pending = serializers.IntegerField(min_value=0, max_value=9999, default=0)
    carry = serializers.IntegerField(min_value=0, max_value=69, default=0,
                                     help_text="70 点に満たずに持ち越している得点")
    all_clear_bonus = serializers.BooleanField(default=False, help_text="全消し直後（次の消去にボーナス）")

    def validate_rows(self, rows: list[str]) -> list[str]:
        return rows + ["0" * W] * (H - len(rows))


class MoveRequestSerializer(serializers.Serializer):
    position = PositionSerializer()
    agent = serializers.CharField(required=False, allow_blank=True, default="")


class PlacementSerializer(serializers.Serializer):
    x = serializers.IntegerField(help_text="軸を置く列（0 が左端）")
    rot = serializers.IntegerField(help_text="0 = 子が上、1 = 右、2 = 下、3 = 左")


class MoveResponseSerializer(serializers.Serializer):
    agent = serializers.CharField()
    agent_episode = serializers.IntegerField(allow_null=True, help_text="何エピソード目まで学習した重みか")
    placement = PlacementSerializer()
    path = serializers.ListField(child=serializers.CharField(),
                                 help_text="出たばかりの組に対する操作列（L/R/CW/CCW/HD）")
    expected = serializers.DictField(help_text="この手の見込み（連鎖数・送るおじゃま・得点など）")


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()
