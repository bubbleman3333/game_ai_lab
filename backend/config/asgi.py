"""HTTP は Django、WebSocket（/ws/...）は Channels に振り分ける。"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402  Django の初期化後に import する
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from apps.tetris_online.routing import websocket_urlpatterns as tetris_ws  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": AllowedHostsOriginValidator(URLRouter([*tetris_ws])),
    }
)
