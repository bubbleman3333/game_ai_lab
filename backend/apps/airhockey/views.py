"""エアホッケーの API（Controller 層）。試合そのものはブラウザで動き、AI の方策（小さなネット）もブラウザで計算する。

GET  /api/airhockey/agents/               使える AI の一覧（先頭が既定）
GET  /api/airhockey/agents/<id>/policy/   方策の重み（JSON）
POST /api/airhockey/matches/              人と AI の試合結果を保存
GET  /api/airhockey/matches/summary/      AI・速さごとの人の勝ち負け
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import agent_registry, selectors, services
from .serializers import AgentSerializer, MatchCreateSerializer, SummaryRowSerializer


class AgentListView(APIView):
    def get(self, request):
        return Response(AgentSerializer(agent_registry.list_agents(), many=True).data)


class PolicyView(APIView):
    def get(self, request, agent_id: str):
        return Response(agent_registry.policy_json(agent_id))


class MatchCreateView(APIView):
    def post(self, request):
        req = MatchCreateSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        services.save_match(**req.validated_data)
        return Response({"ok": True}, status=status.HTTP_201_CREATED)


class SummaryView(APIView):
    def get(self, request):
        return Response(SummaryRowSerializer(selectors.summary(), many=True).data)
