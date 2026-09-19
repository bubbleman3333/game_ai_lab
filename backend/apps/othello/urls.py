from django.urls import path

from .views import AgentListView, GameListCreateView, SpecView, SummaryView, WeightsView

urlpatterns = [
    path("agents/", AgentListView.as_view()),
    path("agents/<str:agent_id>/weights/", WeightsView.as_view()),
    path("spec/", SpecView.as_view()),
    path("games/", GameListCreateView.as_view()),
    path("games/summary/", SummaryView.as_view()),
]
