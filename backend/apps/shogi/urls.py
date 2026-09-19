from django.urls import path

from .views import AgentListView, GameActionView, GameCreateView, GameDetailView, GameMoveView, LevelListView, SummaryView

urlpatterns = [
    path("agents/", AgentListView.as_view()),
    path("levels/", LevelListView.as_view()),
    path("games/", GameCreateView.as_view()),
    path("games/summary/", SummaryView.as_view()),
    path("games/<int:game_id>/", GameDetailView.as_view()),
    path("games/<int:game_id>/move/", GameMoveView.as_view()),
    path("games/<int:game_id>/undo/", GameActionView.as_view(action="undo")),
    path("games/<int:game_id>/resign/", GameActionView.as_view(action="resign")),
    path("games/<int:game_id>/declare/", GameActionView.as_view(action="declare")),
]
