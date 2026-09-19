from django.urls import re_path

from .consumers import RoomConsumer

websocket_urlpatterns = [
    # テトリスとブロブチェインで共通。/ws/<game>/rooms/<code>/
    re_path(r"^ws/(?P<game>tetris|blob)/rooms/(?P<code>[A-Za-z0-9]{4,8})/$", RoomConsumer.as_asgi()),
]
