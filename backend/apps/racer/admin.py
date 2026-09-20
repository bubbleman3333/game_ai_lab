from django.contrib import admin

from .models import RaceResult


@admin.register(RaceResult)
class RaceResultAdmin(admin.ModelAdmin):
    list_display = ["created_at", "course", "car", "agent", "total_sec", "best_lap_sec", "place"]
    list_filter = ["course", "car"]
