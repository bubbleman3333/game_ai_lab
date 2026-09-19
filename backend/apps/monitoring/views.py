"""利用状況の API（Controller 層）。

POST /api/monitoring/heartbeat/     画面から 15 秒ごとの合図（誰でも）
POST /api/monitoring/client-error/  画面で起きたエラー（誰でも）
GET  /api/monitoring/live/          今遊んでいる人・今日の数・最近の出来事（合言葉が必要）
    合言葉はヘッダー X-Monitor-Token で送る。値は backend/.monitor_token（最初の起動で作られる）
"""

import secrets

from django.conf import settings
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import selectors, services
from .models import Event


class HeartbeatSerializer(serializers.Serializer):
    session_id = serializers.RegexField(r"^[A-Za-z0-9-]{8,64}$")
    path = serializers.CharField(max_length=200)
    device = serializers.ChoiceField(choices=["mobile", "desktop"])
    nickname = serializers.CharField(max_length=20, allow_blank=True, default="")
    leaving = serializers.BooleanField(default=False)


class ClientErrorSerializer(serializers.Serializer):
    session_id = serializers.CharField(max_length=64, allow_blank=True, default="")
    path = serializers.CharField(max_length=200, allow_blank=True, default="")
    message = serializers.CharField(max_length=300)
    stack = serializers.CharField(max_length=2000, allow_blank=True, default="")


class MonitorThrottle(AnonRateThrottle):
    scope = "monitoring"


class HeartbeatView(APIView):
    throttle_classes = [MonitorThrottle]

    def post(self, request):
        req = HeartbeatSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        d = req.validated_data
        if d["leaving"]:
            services.leave(d["session_id"])
        else:
            services.heartbeat(d["session_id"], d["path"], d["device"], d["nickname"])
        return Response({"ok": True})


class ClientErrorView(APIView):
    throttle_classes = [MonitorThrottle]

    def post(self, request):
        req = ClientErrorSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        d = req.validated_data
        services.record_event(Event.Kind.CLIENT_ERROR, d["message"], game=services.game_of(d["path"]),
                              data={"path": d["path"], "stack": d["stack"]}, session_id=d["session_id"])
        return Response({"ok": True})


class LiveView(APIView):
    def get(self, request):
        token = request.headers.get("X-Monitor-Token", "")
        if not secrets.compare_digest(token.encode(), settings.MONITOR_TOKEN.encode()):
            raise PermissionDenied("合言葉が違います")
        services.cleanup()
        return Response(selectors.live())
