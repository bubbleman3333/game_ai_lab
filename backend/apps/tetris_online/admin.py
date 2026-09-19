from django.contrib import admin

from .models import MatchResult, Room


@admin.register(Room)
class RoomAdmin(admin.ModelAdmin):
    list_display = ["code", "status", "round", "created_at"]


@admin.register(MatchResult)
class MatchResultAdmin(admin.ModelAdmin):
    list_display = ["room", "round", "winner_name", "loser_name", "reason", "created_at"]
