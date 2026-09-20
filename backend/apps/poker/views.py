"""ポーカーの API（Controller 層）。

GET  /api/poker/agents/                使える AI の一覧（先頭が既定）
POST /api/poker/tables/                テーブルを作って 1 局目を配る
GET  /api/poker/tables/<id>/           今の局面（**AI の手札は入らない**）
POST /api/poker/tables/<id>/action/    人の手を打つ（fold / check / call / raise + 額）
POST /api/poker/tables/<id>/next/      次の局を配る
GET  /api/poker/stats/                 人間相手の成績と直近の局

相手の手札が見えないゲームなので、局の状態はサーバーに持つ（apps/poker/models.py 参照）。
"""

from dataclasses import asdict

from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import agent_registry, selectors, services
from .serializers import ActionSerializer, AgentSerializer, TableCreateSerializer, table_view


class PokerThrottle(AnonRateThrottle):
    scope = "ai_move"


class AgentListView(APIView):
    def get(self, request):
        agents = [asdict(a) for a in agent_registry.list_agents()]
        for a in agents:
            a.pop("path", None)
            a.pop("updated_at", None)
        return Response(AgentSerializer(agents, many=True).data)


class TableCreateView(APIView):
    throttle_classes = [PokerThrottle]

    def post(self, request):
        req = TableCreateSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        table = services.create_table(req.validated_data.get("agent") or None,
                                     req.validated_data["stack"])
        return Response(table_view(table), status=201)


class TableDetailView(APIView):
    def get(self, request, table_id):
        return Response(table_view(services.get_table(table_id)))


class ActionView(APIView):
    throttle_classes = [PokerThrottle]

    def post(self, request, table_id):
        req = ActionSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        table = services.human_action(services.get_table(table_id),
                                      req.validated_data["kind"], req.validated_data["to"])
        return Response(table_view(table))


class NextHandView(APIView):
    throttle_classes = [PokerThrottle]

    def post(self, request, table_id):
        return Response(table_view(services.deal_next_hand(services.get_table(table_id))))


class StatsView(APIView):
    def get(self, request):
        return Response({"agents": selectors.agent_stats(), "recent": selectors.recent_hands()})
