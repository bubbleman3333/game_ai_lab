from django.urls import path

from .views import AgentListView, MoveView

urlpatterns = [
    path("agents/", AgentListView.as_view(), name="blob-agents"),
    path("move/", MoveView.as_view(), name="blob-move"),
]
