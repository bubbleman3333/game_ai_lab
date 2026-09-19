"""学習結果の API（Controller 層）。強さページが使う。

GET  /api/training/runs/?game=tetris                    学習の一覧
GET  /api/training/runs/<game>/<name>/                  詳細
GET  /api/training/runs/<game>/<name>/metrics/?bucket=50  エピソードをまとめた推移
GET  /api/training/runs/<game>/<name>/evaluations/      評価の推移
POST /api/training/sync/                                runs/ を取り込む（開発用）
"""

from django.conf import settings
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView

from . import selectors, services
from .serializers import EvaluationSerializer, MetricBucketSerializer, SyncResultSerializer, TrainingRunSerializer


class RunListView(APIView):
    def get(self, request):
        runs = selectors.list_runs(request.query_params.get("game") or None)
        return Response(TrainingRunSerializer(runs, many=True).data)


class RunDetailView(APIView):
    def get(self, request, game: str, name: str):
        return Response(TrainingRunSerializer(selectors.get_run(game, name)).data)


class RunMetricsView(APIView):
    def get(self, request, game: str, name: str):
        try:
            bucket = max(1, min(5000, int(request.query_params.get("bucket", 50))))
        except ValueError:
            bucket = 50
        rows = selectors.metric_buckets(selectors.get_run(game, name), bucket)
        return Response({"bucket": bucket, "points": MetricBucketSerializer(rows, many=True).data})


class RunEvaluationsView(APIView):
    def get(self, request, game: str, name: str):
        run = selectors.get_run(game, name)
        return Response(EvaluationSerializer(selectors.list_evaluations(run), many=True).data)


class SyncView(APIView):
    def post(self, request):
        if not settings.TRAINING_ALLOW_SYNC_API:
            raise PermissionDenied("この環境では manage.py sync_runs で取り込んでください")
        return Response(SyncResultSerializer(services.sync_all_runs(), many=True).data)
