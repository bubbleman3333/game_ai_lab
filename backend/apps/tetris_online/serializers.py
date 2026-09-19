from rest_framework import serializers

from .models import MatchResult, Room


class RoomPlayerSerializer(serializers.Serializer):
    slot = serializers.IntegerField()
    name = serializers.CharField()
    ready = serializers.BooleanField()
    alive = serializers.BooleanField()
    wins = serializers.IntegerField()


class MatchResultSerializer(serializers.ModelSerializer):
    class Meta:
        model = MatchResult
        fields = ["round", "winner_name", "loser_name", "winner_slot", "reason", "duration_sec", "created_at"]


class RoomSerializer(serializers.ModelSerializer):
    players = RoomPlayerSerializer(many=True, read_only=True)

    class Meta:
        model = Room
        fields = ["code", "status", "round", "players", "created_at"]


class RoomDetailSerializer(RoomSerializer):
    recent_results = serializers.SerializerMethodField()

    class Meta(RoomSerializer.Meta):
        fields = [*RoomSerializer.Meta.fields, "recent_results"]

    def get_recent_results(self, room: Room):
        return MatchResultSerializer(room.results.all()[:10], many=True).data
