from django.contrib import admin

from .models import PokerHand, PokerTable


@admin.register(PokerTable)
class PokerTableAdmin(admin.ModelAdmin):
    list_display = ("id", "agent", "hand_no", "stacks", "updated_at")
    search_fields = ("agent",)


@admin.register(PokerHand)
class PokerHandAdmin(admin.ModelAdmin):
    list_display = ("created_at", "agent", "hand_no", "stack_bb", "human_payoff", "pot", "showdown")
    list_filter = ("agent", "showdown")
