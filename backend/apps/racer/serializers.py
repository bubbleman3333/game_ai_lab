from rest_framework import serializers


class AgentSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    run = serializers.CharField(allow_null=True)
    kind = serializers.CharField()


class ResultCreateSerializer(serializers.Serializer):
    course = serializers.CharField(max_length=50)
    car = serializers.CharField(max_length=50)
    agent = serializers.CharField(max_length=100)
    laps = serializers.IntegerField(min_value=1, max_value=20)
    total_sec = serializers.FloatField(min_value=0)
    best_lap_sec = serializers.FloatField(min_value=0)
    tricks = serializers.IntegerField(min_value=0, default=0)
    falls = serializers.IntegerField(min_value=0, default=0)
    place = serializers.IntegerField(min_value=1, allow_null=True, required=False)
    racers = serializers.IntegerField(min_value=1, default=1)


class SummaryRowSerializer(serializers.Serializer):
    course = serializers.CharField()
    car = serializers.CharField()
    runs = serializers.IntegerField()
    best_lap = serializers.FloatField(allow_null=True)
    best_total = serializers.FloatField(allow_null=True)
    wins = serializers.IntegerField()
    losses = serializers.IntegerField()
