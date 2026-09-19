from django.contrib import admin

from .models import ShogiGame


@admin.register(ShogiGame)
class ShogiGameAdmin(admin.ModelAdmin):
    list_display = ["created_at", "agent", "level", "human_color", "result", "reason"]
