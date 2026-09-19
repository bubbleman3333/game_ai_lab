"""将棋の API（Controller 層）。ルールの判定と AI の探索はサーバーで行う。

GET  /api/shogi/agents/                使える AI の一覧（先頭が既定）
GET  /api/shogi/levels/                強さの一覧
POST /api/shogi/games/                 対局を始める（人が後手なら AI が初手を指して返す）
GET  /api/shogi/games/<id>/            対局の状態
POST /api/shogi/games/<id>/move/       人が指す → AI が応じた後の状態を返す（最強だと数秒かかる）
POST /api/shogi/games/<id>/undo/       待った
POST /api/shogi/games/<id>/resign/     投了
POST /api/shogi/games/<id>/declare/    入玉宣言
GET  /api/shogi/games/summary/         AI・強さごとの人の勝ち負け
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import agent_registry, selectors, services
from .serializers import AgentSerializer, MoveSerializer, StartSerializer, SummaryRowSerializer


class AgentListView(APIView):
    def get(self, request):
        return Response(AgentSerializer(agent_registry.list_agents(), many=True).data)


class LevelListView(APIView):
    def get(self, request):
        return Response([{"id": k, "label": v["label"]} for k, v in services.LEVELS.items()])


class GameCreateView(APIView):
    def post(self, request):
        req = StartSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        game = services.start_game(**req.validated_data)
        return Response(selectors.game_state(game), status=status.HTTP_201_CREATED)


class GameDetailView(APIView):
    def get(self, request, game_id: int):
        return Response(selectors.game_state(selectors.get_game(game_id)))


class GameMoveView(APIView):
    def post(self, request, game_id: int):
        req = MoveSerializer(data=request.data)
        req.is_valid(raise_exception=True)
        return Response(selectors.game_state(services.play(game_id, req.validated_data["move"])))


class GameActionView(APIView):
    """undo / resign / declare"""

    action = ""

    def post(self, request, game_id: int):
        fn = {"undo": services.take_back, "resign": services.resign, "declare": services.declare}[self.action]
        return Response(selectors.game_state(fn(game_id)))


class SummaryView(APIView):
    def get(self, request):
        return Response(SummaryRowSerializer(selectors.summary(), many=True).data)
