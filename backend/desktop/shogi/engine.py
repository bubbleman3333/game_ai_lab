"""AI（学習したネット + モンテカルロ木探索）を別スレッドで動かす。画面（Qt）には依存しない。

- think: AI の手番。決めた時間だけ読んで手を返す
- ponder: 人の手番の間も読み続ける（先読み）。人が指したら止め、その手の先の読みを次の think がそのまま使う
  （探索の木を使い回す。rl/shogi/mcts.py）。人が 30 秒考えれば、AI は 30 秒ぶん余計に読めることになる
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import torch
from cshogi import Board

from rl.common import runs_dir
from rl.shogi.mcts import MCTS, SearchResult
from rl.shogi.model import load

BATCH_SIZE = 64


@dataclass(frozen=True)
class ModelInfo:
    id: str  # "v2"
    label: str
    path: Path


PREFERRED = "v2"  # 既定で使う AI（対局で一番強かったもの。README の「強さ」）


def list_models() -> list[ModelInfo]:
    """学習済みのネット（runs/shogi/<run>/checkpoints/best.pt）。既定（PREFERRED）が先頭、学習中のものは最後。"""
    found = []
    for p in runs_dir("shogi").glob("*/checkpoints/best.pt"):
        run = p.parent.parent
        try:
            meta = torch.load(p, map_location="cpu", weights_only=False)
            state = json.loads((run / "status.json").read_text(encoding="utf-8")).get("state", "")
        except Exception:
            continue
        training = state == "running"
        blocks, ch = meta.get("blocks", 0), meta.get("channels", 0)
        acc = meta.get("meta", {}).get("best", 0.0)
        label = f"{run.name}（{blocks} ブロック × {ch}・一致率 {acc:.1%}）" + ("・学習中" if training else "")
        found.append(((training, run.name != PREFERRED, -acc), ModelInfo(run.name, label, p)))
    found.sort(key=lambda t: t[0])
    return [m for _, m in found]


@dataclass(frozen=True)
class Level:
    label: str
    time: float  # 1 手に使う秒数（0 なら回数だけで止める）
    playouts: int


LEVELS = [
    Level("最強（1 手 30 秒）", 30.0, 10**9),
    Level("最強（1 手 10 秒）", 10.0, 10**9),
    Level("とても強い（1 手 5 秒）", 5.0, 10**9),
    Level("強い（1 手 2 秒）", 2.0, 10**9),
    Level("早指し（1 手 0.5 秒）", 0.5, 10**9),
    Level("手加減（1000 回読む）", 0, 1000),
    Level("やさしい（100 回読む）", 0, 100),
    Level("入門（読まずに第一感）", 0, 1),
]
DEFAULT_LEVEL = 1


class Engine:
    def __init__(self) -> None:
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.mcts: MCTS | None = None
        self.model_id: str | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def load(self, info: ModelInfo) -> None:
        """ネットを読み込む（数秒かかる。GPU の準備を含む）。"""
        self.stop()
        model, _ = load(info.path, self.device)
        self.mcts = MCTS(model, self.device, batch_size=BATCH_SIZE)
        self.model_id = info.id

    @property
    def busy(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def stop(self) -> None:
        """考えている途中なら止める（止まるまで待つ）。"""
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        self._thread = None
        self._stop = threading.Event()

    def new_game(self) -> None:
        self.stop()
        if self.mcts:
            self.mcts.clear()

    def _start(self, fn: Callable[[], None]) -> None:
        """前の思考は呼ぶ側で止めてあること（止めるときに _stop が作り直されるので、その後で fn が新しい _stop を持つ）。"""
        self._thread = threading.Thread(target=fn, daemon=True)
        self._thread.start()

    def think(self, board: Board, level: Level, on_progress: Callable[[SearchResult], None],
              on_done: Callable[[SearchResult | None, str | None], None]) -> None:
        """AI の手を考える（別スレッド）。終わったら on_done(結果, エラー) を呼ぶ。"""
        self.stop()
        board = board.copy()
        stop = self._stop
        # 回数で止める弱い設定では、先読みで増えた分を使わない（強さが設定どおりになるように）
        reuse = level.time > 0

        def run() -> None:
            try:
                if level.playouts <= 1:
                    r = self.mcts.search(board, playouts=1, mate_search=False, reuse=False)
                else:
                    r = self.mcts.search(board, playouts=level.playouts, time_limit=level.time, stop=stop,
                                         on_progress=on_progress, mate_search=level.time > 0, reuse=reuse)
                on_done(None if stop.is_set() else r, None)
            except Exception as e:  # 画面に出す
                on_done(None, repr(e))

        self._start(run)

    def ponder(self, board: Board, on_progress: Callable[[SearchResult], None]) -> None:
        """人の手番の間、止められるまで読み続ける（別スレッド）。"""
        self.stop()
        board = board.copy()
        stop = self._stop

        def run() -> None:
            try:
                self.mcts.search(board, playouts=10**9, time_limit=0, stop=stop, on_progress=on_progress,
                                 progress_every=1.0, mate_search=False)
            except Exception:
                pass  # 先読みは失敗しても対局に影響しない

        self._start(run)
