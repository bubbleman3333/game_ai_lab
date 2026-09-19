"""対戦部屋の REST API（Controller 層）。対戦そのものは WebSocket（consumers.py）。
テトリスは /api/tetris/rooms/、ブロブチェインは /api/blob/rooms/（config/urls.py で game を渡している）。

POST /api/tetris/rooms/          部屋を作る → {"code": "ABCDE", ...}
GET  /api/tetris/rooms/          相手を待っている部屋の一覧（ロビー用）
GET  /api/tetris/rooms/<code>/   部屋の詳細と最近の結果
"""

from rest_framework import mixins, status, viewsets
from rest_framework.response import Response

from . import selectors, services
from .serializers import RoomDetailSerializer, RoomSerializer


class RoomViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    lookup_field = "code"
    serializer_class = RoomSerializer

    @property
    def game(self) -> str:
        return self.kwargs.get("game", "tetris")

    def get_queryset(self):
        return selectors.list_open_rooms(self.game)

    def get_object(self):
        return selectors.get_room(self.kwargs["code"], self.game)

    def get_serializer_class(self):
        return RoomDetailSerializer if self.action == "retrieve" else RoomSerializer

    def create(self, request, *args, **kwargs):
        room = services.create_room(self.game)
        return Response(RoomSerializer(room).data, status=status.HTTP_201_CREATED)
