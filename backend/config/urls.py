from django.contrib import admin
from django.urls import include, path
from rest_framework.decorators import api_view
from rest_framework.response import Response


@api_view(["GET"])
def health(request):
    return Response({"status": "ok"})


# ゲームごとに /api/<ゲーム>/ の下にまとめる。学習結果はゲーム共通で /api/training/
urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", health),
    path("api/training/", include("apps.training.urls")),
    path("api/tetris/", include("apps.tetris_ai.urls")),
    path("api/tetris/", include("apps.tetris_online.urls"), {"game": "tetris"}),
    path("api/blob/", include("apps.tetris_online.urls"), {"game": "blob"}),  # ブロブチェインも同じ対戦の仕組み
    path("api/othello/", include("apps.othello.urls")),
    path("api/airhockey/", include("apps.airhockey.urls")),
    path("api/racer/", include("apps.racer.urls")),
    path("api/shogi/", include("apps.shogi.urls")),
    path("api/monitoring/", include("apps.monitoring.urls")),
]
