from django.urls import path

from . import views

urlpatterns = [
    path("agents/", views.AgentListView.as_view()),
    path("tables/", views.TableCreateView.as_view()),
    path("tables/<str:table_id>/", views.TableDetailView.as_view()),
    path("tables/<str:table_id>/action/", views.ActionView.as_view()),
    path("tables/<str:table_id>/next/", views.NextHandView.as_view()),
    path("stats/", views.StatsView.as_view()),
]
