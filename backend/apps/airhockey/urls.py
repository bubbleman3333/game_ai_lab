from django.urls import path

from .views import AgentListView, MatchCreateView, PolicyView, SummaryView

urlpatterns = [
    path("agents/", AgentListView.as_view()),
    path("agents/<str:agent_id>/policy/", PolicyView.as_view()),
    path("matches/", MatchCreateView.as_view()),
    path("matches/summary/", SummaryView.as_view()),
]
