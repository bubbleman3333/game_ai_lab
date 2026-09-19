"""runs/<ゲーム>/ にある学習結果（metrics.jsonl / evals.jsonl）を DB に取り込む。

    python manage.py sync_runs            # 1 回だけ
    python manage.py sync_runs --watch 30 # 30 秒ごとに取り込み続ける（学習中に使う）
"""

import time

from django.core.management.base import BaseCommand

from apps.training.services import sync_all_runs


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, parser):
        parser.add_argument("--watch", type=int, default=0, help="この秒数ごとに繰り返す")

    def handle(self, *args, watch: int, **options):
        while True:
            for r in sync_all_runs():
                self.stdout.write(f"{r.game}/{r.run}: +{r.new_metrics} metrics, +{r.new_evaluations} evaluations")
            if not watch:
                break
            time.sleep(watch)
