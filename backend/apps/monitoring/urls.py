from django.urls import path

from .views import ClientErrorView, HeartbeatView, LiveView

urlpatterns = [
    path("heartbeat/", HeartbeatView.as_view()),
    path("client-error/", ClientErrorView.as_view()),
    path("live/", LiveView.as_view()),
]
