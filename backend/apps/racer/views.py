"""レースの API（Controller 層）。レースそのものはブラウザで動き、AI の方策もブラウザで計算する。

GET  /api/racer/agents/              使える AI の一覧（先頭が既定）
GET  /api/racer/agents/<id>/policy/  方策の重み（JSON）
POST /api/racer/results/             人の走行結果を保存
GET  /api/racer/results/summary/     コース・車ごとのベストタイムと AI との勝ち負け
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import agent_registry, selectors, services
from .serializers import AgentSerializer, ResultCreateSerializer, SummaryRowSerializer


class AgentListView(APIView):
    def get(self, request):
        return Response(AgentSerializer(agent_registry.list_agents(), many=True).data)


class PolicyView(APIView):
    def get(self, request, agent_id: str):
        return Response(agent_registry.policy_json(agent_id))


class ResultCreateView(APIView):
    def post(self, request):
        req = ResultCreateSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        services.save_result(**req.validated_data)
        return Response({"ok": True}, status=status.HTTP_201_CREATED)


class SummaryView(APIView):
    def get(self, request):
        return Response(SummaryRowSerializer(selectors.summary(), many=True).data)
