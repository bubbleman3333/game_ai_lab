"""人と AI のポーカー（テーブル）と、終わった局の記録。

ポーカーは**相手の手札が見えない**ので、ほかのゲームのように「盤面を全部ブラウザに渡して
ブラウザ側で進める」作りにできない。渡した瞬間に AI の手札が見えてしまう。
そこで**局の状態はサーバーに持ち**、ブラウザには「その人に見せていいもの」だけを返す。

席は固定で、**人が 0 番・AI が 1 番**。ボタン（スモールブラインド）は 1 局ごとに交代する。
"""

from __future__ import annotations

import uuid

from django.db import models


class PokerTable(models.Model):
    """遊んでいるテーブル 1 つ。スタックを持ち越すので「飛ぶ」ことがある。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    agent = models.CharField(max_length=100)  # 使った AI の ID
    start_stack = models.IntegerField()  # 最初のスタック（チップ）
    stacks = models.JSONField(default=list)  # 今のスタック [人, AI]
    hand_no = models.IntegerField(default=0)  # 何局目か（1 から）
    state = models.JSONField(null=True, blank=True)  # 今の局の状態（games.poker.State）
    hist = models.CharField(max_length=128, default="")  # AI に渡す行動の履歴（枠の番号の並び）
    log = models.JSONField(default=list)  # 今の局の読み上げ
    result = models.JSONField(null=True, blank=True)  # 終わった局の結果（次を配るまで残す）
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        return f"{self.id} vs {self.agent} ({self.hand_no}局)"


class PokerHand(models.Model):
    """終わった局の記録。AI が人間相手にどれだけ勝てているかを見るために残す。"""

    table = models.ForeignKey(PokerTable, related_name="hands", on_delete=models.CASCADE)
    hand_no = models.IntegerField()
    agent = models.CharField(max_length=100)
    stack_bb = models.IntegerField()  # その局の有効スタック（ビッグブラインド何個分か）
    human_payoff = models.IntegerField()  # 人から見た収支（チップ）
    pot = models.IntegerField()
    showdown = models.BooleanField()  # 手札を見せ合って決まったか（False = どちらかが降りた）
    board = models.CharField(max_length=32, blank=True)
    human_hole = models.CharField(max_length=8)
    ai_hole = models.CharField(max_length=8)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
