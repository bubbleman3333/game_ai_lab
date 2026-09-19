"""オセロの API（Controller 層）。AI の読み（探索）はブラウザで行い、サーバーは評価関数の重みを配る。

GET  /api/othello/agents/                使える評価関数の一覧（先頭が既定）
GET  /api/othello/spec/                  パターン定義（重みの並び方）
GET  /api/othello/agents/<id>/weights/   重み（Float32 のバイナリ）
POST /api/othello/games/                 人と AI の対局を保存（サーバーで棋譜を確かめる）
GET  /api/othello/games/                 最近の対局
GET  /api/othello/games/summary/         AI・強さごとの、人の勝ち負け
"""

from django.http import HttpResponse
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from rl.othello.ntuple import spec

from . import agent_registry, selectors, services
from .serializers import AgentSerializer, GameCreateSerializer, GameSerializer, SummaryRowSerializer


class AgentListView(APIView):
    def get(self, request):
        return Response(AgentSerializer(agent_registry.list_agents(), many=True).data)


class SpecView(APIView):
    def get(self, request):
        return Response(spec())


class WeightsView(APIView):
    def get(self, request, agent_id: str):
        data = agent_registry.weights_bytes(agent_id)
        res = HttpResponse(data, content_type="application/octet-stream")
        res["Cache-Control"] = "no-cache"
        return res


class GameListCreateView(APIView):
    def get(self, request):
        return Response(GameSerializer(selectors.recent_games(), many=True).data)

    def post(self, request):
        req = GameCreateSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        game = services.save_game(**req.validated_data)
        return Response(GameSerializer(game).data, status=status.HTTP_201_CREATED)


class SummaryView(APIView):
    def get(self, request):
        return Response(SummaryRowSerializer(selectors.summary(), many=True).data)
