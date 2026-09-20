from django.urls import path

from .views import AgentListView, PolicyView, ResultCreateView, SummaryView

urlpatterns = [
    path("agents/", AgentListView.as_view()),
    path("agents/<str:agent_id>/policy/", PolicyView.as_view()),
    path("results/", ResultCreateView.as_view()),
    path("results/summary/", SummaryView.as_view()),
]
