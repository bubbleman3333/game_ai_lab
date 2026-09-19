from django.urls import path

from .views import RunDetailView, RunEvaluationsView, RunListView, RunMetricsView, SyncView

urlpatterns = [
    path("runs/", RunListView.as_view()),
    path("runs/<str:game>/<str:name>/", RunDetailView.as_view()),
    path("runs/<str:game>/<str:name>/metrics/", RunMetricsView.as_view()),
    path("runs/<str:game>/<str:name>/evaluations/", RunEvaluationsView.as_view()),
    path("sync/", SyncView.as_view()),
]
