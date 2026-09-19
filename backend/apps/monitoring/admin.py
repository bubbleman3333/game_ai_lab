from django.contrib import admin

from .models import Event, Presence


@admin.register(Presence)
class PresenceAdmin(admin.ModelAdmin):
    list_display = ["nickname", "path", "device", "first_seen", "last_seen"]


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    list_display = ["created_at", "kind", "game", "message"]
    list_filter = ["kind", "game"]
