"""テトリス AI の API（Controller 層）。学習結果の API は apps/training。

GET  /api/tetris/agents/   使える AI の一覧（先頭が既定）
POST /api/tetris/move/     局面を送ると AI の手（操作列）を返す
"""

from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import agent_registry, services
from .serializers import AgentSerializer, MoveRequestSerializer, MoveResponseSerializer


class MoveThrottle(AnonRateThrottle):
    scope = "ai_move"


class AgentListView(APIView):
    def get(self, request):
        return Response(AgentSerializer(agent_registry.list_agents(), many=True).data)


class MoveView(APIView):
    throttle_classes = [MoveThrottle]

    def post(self, request):
        req = MoveRequestSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        move = services.choose_move(req.validated_data["position"], req.validated_data["agent"] or None)
        return Response(MoveResponseSerializer(move).data)
