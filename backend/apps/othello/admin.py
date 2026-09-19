from django.contrib import admin

from .models import OthelloGame


@admin.register(OthelloGame)
class OthelloGameAdmin(admin.ModelAdmin):
    list_display = ["created_at", "agent", "level", "human_color", "human_result"]
