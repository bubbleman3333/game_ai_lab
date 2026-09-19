from django.contrib import admin

from .models import AirHockeyMatch


@admin.register(AirHockeyMatch)
class AirHockeyMatchAdmin(admin.ModelAdmin):
    list_display = ["created_at", "agent", "level", "human_score", "ai_score"]
