"""メインウィンドウ（盤・設定・AI の読み・棋譜）。

AI は別スレッドで考え、途中経過と結果は Qt のシグナルで画面のスレッドに渡す
（Qt の部品は画面のスレッドからしか触れないため）。
"""

from __future__ import annotations

import math
import threading

from cshogi import BLACK, WHITE
from PySide6.QtCore import QObject, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (QCheckBox, QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QListWidget,
                               QMainWindow, QMessageBox, QProgressBar, QPushButton, QVBoxLayout, QWidget)

from .board_view import BoardView
from .engine import DEFAULT_LEVEL, LEVELS, Engine, list_models
from .game import Game

AI_RESIGN_WINRATE = 0.01  # AI は勝率の予想がこれを下回ったら投了する
EVAL_SCALE = 600.0  # 勝率 → 評価値（学習の換算と同じ。rl/shogi/data.py の EVAL_SCALE）


def winrate_to_eval(p: float) -> int:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return int(max(-9999, min(9999, EVAL_SCALE * math.log(p / (1 - p)))))


class Bridge(QObject):
    """別スレッド → 画面のスレッドへの受け渡し。"""
    loaded = Signal(object)  # エラー（無ければ None）
    progress = Signal(object, bool)  # (SearchResult, 先読み中か)
    done = Signal(object, object, int)  # (SearchResult or None, エラー, 対局の番号)


class WinrateGraph(QWidget):
    """手ごとの先手の勝率（AI の読み）のグラフ。"""

    def __init__(self):
        super().__init__()
        self.points: dict[int, float] = {}
        self.setMinimumHeight(90)

    def paintEvent(self, _e) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect()).adjusted(4, 4, -4, -4)
        p.fillRect(self.rect(), QColor("#1f2329"))
        p.setPen(QPen(QColor("#555c66"), 1, Qt.DashLine))
        p.drawLine(QPointF(r.left(), r.center().y()), QPointF(r.right(), r.center().y()))
        if self.points:
            n = max(max(self.points) + 1, 40)
            pts = [QPointF(r.left() + r.width() * k / n, r.bottom() - r.height() * v)
                   for k, v in sorted(self.points.items())]
            p.setPen(QPen(QColor("#f0b44c"), 2))
            for a, b in zip(pts, pts[1:]):
                p.drawLine(a, b)
        p.setPen(QColor("#9aa3ad"))
        p.setFont(QFont("Yu Gothic UI", 8))
        p.drawText(r.adjusted(2, 0, 0, 0), Qt.AlignTop | Qt.AlignLeft, "先手 有利")
        p.drawText(r.adjusted(2, 0, 0, 0), Qt.AlignBottom | Qt.AlignLeft, "後手 有利")
        p.end()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("将棋 AI")
        self.resize(1180, 820)
        self.engine = Engine()
        self.bridge = Bridge()
        self.bridge.loaded.connect(self._on_loaded)
        self.bridge.progress.connect(self._on_progress)
        self.bridge.done.connect(self._on_done)
        self.game = Game()
        self.game_no = 0  # 新しい対局・待ったで増やす（古い対局の考えた結果を捨てるため）
        self.human_color = BLACK
        self.ready = False

        self.board_view = BoardView()
        self.board_view.move_made.connect(self._on_human_move)

        # 設定
        self.color_box = QComboBox()
        self.color_box.addItems(["先手（☗）で指す", "後手（☖）で指す"])
        self.model_box = QComboBox()
        self.models = list_models()
        for m in self.models:
            self.model_box.addItem(m.label)
        self.model_box.currentIndexChanged.connect(self._load_model)
        self.level_box = QComboBox()
        for lv in LEVELS:
            self.level_box.addItem(lv.label)
        self.level_box.setCurrentIndex(DEFAULT_LEVEL)
        self.ponder_box = QCheckBox("あなたの手番の間も AI が考える（先読み）")
        self.ponder_box.setChecked(True)
        self.ponder_box.toggled.connect(self._maybe_ponder)

        new_btn = QPushButton("新しい対局")
        new_btn.clicked.connect(self.new_game)
        self.undo_btn = QPushButton("待った")
        self.undo_btn.clicked.connect(self.undo)
        self.resign_btn = QPushButton("投了")
        self.resign_btn.clicked.connect(self.resign)
        self.declare_btn = QPushButton("入玉宣言")
        self.declare_btn.clicked.connect(self.declare)
        flip_btn = QPushButton("盤を反転")
        flip_btn.clicked.connect(self.flip)

        settings = QGroupBox("対局")
        form = QFormLayout(settings)
        form.addRow("あなた", self.color_box)
        form.addRow("AI", self.model_box)
        form.addRow("強さ", self.level_box)
        form.addRow(self.ponder_box)
        row1 = QHBoxLayout()
        row1.addWidget(new_btn)
        row1.addWidget(self.undo_btn)
        row1.addWidget(self.resign_btn)
        row2 = QHBoxLayout()
        row2.addWidget(self.declare_btn)
        row2.addWidget(flip_btn)
        form.addRow(row1)
        form.addRow(row2)

        self.status = QLabel("AI を準備しています…")
        self.status.setWordWrap(True)
        self.status.setFont(QFont("Yu Gothic UI", 13, QFont.Bold))

        # AI の読み
        think = QGroupBox("AI の読み")
        tv = QVBoxLayout(think)
        self.win_bar = QProgressBar()
        self.win_bar.setRange(0, 1000)
        self.win_bar.setFormat("AI の勝率 %p%")
        self.eval_label = QLabel("—")
        self.pv_label = QLabel("")
        self.pv_label.setWordWrap(True)
        self.pv_label.setMinimumHeight(48)
        self.pv_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        self.nodes_label = QLabel("")
        self.nodes_label.setStyleSheet("color: #9aa3ad")
        self.graph = WinrateGraph()
        tv.addWidget(self.win_bar)
        tv.addWidget(self.eval_label)
        tv.addWidget(QLabel("読み筋:"))
        tv.addWidget(self.pv_label)
        tv.addWidget(self.nodes_label)
        tv.addWidget(self.graph)

        self.kif_list = QListWidget()

        side = QVBoxLayout()
        side.addWidget(settings)
        side.addWidget(self.status)
        side.addWidget(think)
        side.addWidget(QLabel("棋譜"))
        side.addWidget(self.kif_list, 1)
        side_w = QWidget()
        side_w.setLayout(side)
        side_w.setFixedWidth(380)

        root = QWidget()
        h = QHBoxLayout(root)
        h.addWidget(self.board_view, 1)
        h.addWidget(side_w)
        self.setCentralWidget(root)
        self.board_view.set_game(self.game, False)
        self._update_buttons()

        if not self.models:
            self.status.setText("学習済みの AI が見つかりません（runs/shogi/<名前>/checkpoints/best.pt）。\n"
                                "README の手順で学習してください。")
        else:
            self._load_model()

    # --- AI の準備 ----------------------------------------------------------------
    def _load_model(self) -> None:
        if not self.models:
            return
        info = self.models[self.model_box.currentIndex()]
        self.ready = False
        self.game_no += 1
        self._update_buttons()
        self.status.setText(f"AI（{info.id}）を準備しています…")

        def run() -> None:
            try:
                self.engine.load(info)
                self.bridge.loaded.emit(None)
            except Exception as e:
                self.bridge.loaded.emit(repr(e))

        threading.Thread(target=run, daemon=True).start()

    def _on_loaded(self, err) -> None:
        if err:
            self.status.setText(f"AI を読み込めませんでした: {err}")
            return
        self.ready = True
        self.new_game()

    # --- 対局 -------------------------------------------------------------------
    def new_game(self) -> None:
        if not self.ready:
            return
        self.engine.new_game()
        self.game_no += 1
        self.human_color = BLACK if self.color_box.currentIndex() == 0 else WHITE
        self.game = Game()
        self.graph.points = {}
        self.graph.update()
        self.board_view.set_game(self.game, flipped=self.human_color == WHITE)
        self._clear_think()
        self._after_move()

    def _ai_color(self) -> int:
        return 1 - self.human_color

    def _after_move(self) -> None:
        """手が進んだ（または対局が始まった）あとに、画面を更新して次の番を始める。"""
        self.kif_list.clear()
        self.kif_list.addItems([f"{i + 1:>3}  {k}" for i, k in enumerate(self.game.kif())])
        self.kif_list.scrollToBottom()
        if self.game.result:
            self._show_result()
            self.board_view.set_interactive(False)
            self._update_buttons()
            return
        if self.game.turn == self.human_color:
            self.status.setText("あなたの番です" + ("（王手）" if self.game.board.is_check() else ""))
            self.board_view.set_interactive(True)
            self._maybe_ponder()
        else:
            self.status.setText("AI が考えています…")
            self.board_view.set_interactive(False)
            level = LEVELS[self.level_box.currentIndex()]
            no = self.game_no
            self.engine.think(self.game.board, level,
                              on_progress=lambda r: self.bridge.progress.emit(r, False),
                              on_done=lambda r, err: self.bridge.done.emit(r, err, no))
        self._update_buttons()

    def _maybe_ponder(self) -> None:
        if (self.ready and self.ponder_box.isChecked() and not self.game.result
                and self.game.turn == self.human_color and LEVELS[self.level_box.currentIndex()].time > 0):
            self.engine.ponder(self.game.board, on_progress=lambda r: self.bridge.progress.emit(r, True))
        elif self.game.turn == self.human_color:
            self.engine.stop()

    def _on_human_move(self, usi: str) -> None:
        self.engine.stop()  # 先読みを止める（読んだ分は木に残り、AI の番でそのまま使われる）
        self.game.push(usi)
        self.board_view.refresh()
        self._after_move()

    def _on_done(self, r, err, no: int) -> None:
        if no != self.game_no:
            return  # 新しい対局・待ったの前に考え始めた結果
        if err:
            self.status.setText(f"AI でエラーが起きました: {err}")
            return
        if r is None:
            return
        self._show_think(r, pondering=False)
        ai = self._ai_color()
        if r.move == "win":
            self.game.declare()
        elif r.winrate < AI_RESIGN_WINRATE and not r.mate and len(self.game.moves) > 30:
            self.game.resign(ai)
        else:
            black_wr = r.winrate if ai == BLACK else 1 - r.winrate
            self.graph.points[len(self.game.moves) + 1] = black_wr
            self.graph.update()
            self.game.push(r.move)
        self.board_view.refresh()
        self._after_move()

    def undo(self) -> None:
        """待った: あなたの直前の手まで戻す。"""
        if not self.ready or not self.game.moves:
            return
        self.engine.stop()
        self.game_no += 1
        if self.game.result and self.game.result.reason in ("投了", "入玉宣言"):
            n = 0  # 投了・宣言だけを取り消す
        else:
            n = 2 if self.game.turn == self.human_color else 1  # AI の手とあなたの手 / AI が考え中ならあなたの手だけ
        self.game.undo(n)
        for k in [k for k in self.graph.points if k > len(self.game.moves)]:
            del self.graph.points[k]
        self.graph.update()
        self.board_view.refresh()
        self._clear_think()
        self._after_move()

    def resign(self) -> None:
        if not self.ready or self.game.result:
            return
        self.engine.stop()
        self.game_no += 1
        self.game.resign(self.human_color)
        self._after_move()

    def declare(self) -> None:
        if self.game.result or self.game.turn != self.human_color:
            return
        if not self.game.declare():
            QMessageBox.information(self, "入玉宣言", "入玉宣言の条件を満たしていません。")
            return
        self.engine.stop()
        self._after_move()

    def flip(self) -> None:
        self.board_view.flipped = not self.board_view.flipped
        self.board_view.update()

    # --- 表示 -------------------------------------------------------------------
    def _update_buttons(self) -> None:
        playing = self.ready and not self.game.result
        human = playing and self.game.turn == self.human_color
        self.undo_btn.setEnabled(self.ready and bool(self.game.moves))
        self.resign_btn.setEnabled(playing)
        self.declare_btn.setEnabled(human and self.game.can_declare())

    def _show_result(self) -> None:
        res = self.game.result
        if res.winner is None:
            text = f"引き分け（{res.reason}）"
        elif res.winner == self.human_color:
            text = f"あなたの勝ちです！（{res.reason}）"
        else:
            text = f"AI の勝ちです（{res.reason}）"
        self.status.setText(text + f"　{len(self.game.moves)} 手")

    def _clear_think(self) -> None:
        self.win_bar.setValue(500)
        self.eval_label.setText("—")
        self.pv_label.setText("")
        self.nodes_label.setText("")

    def _on_progress(self, r, pondering: bool) -> None:
        self._show_think(r, pondering)

    def _show_think(self, r, pondering: bool) -> None:
        # 先読み中の根は「あなたの番」の局面なので、AI から見た勝率は裏返す
        ai_wr = 1 - r.winrate if pondering else r.winrate
        self.win_bar.setValue(int(ai_wr * 1000))
        ev = winrate_to_eval(ai_wr)
        if r.mate and not pondering:
            self.eval_label.setText(f"詰みを読み切りました（{len(r.pv)} 手詰め）")
        else:
            self.eval_label.setText(f"AI から見た評価値 {ev:+d}")
        pv = self.game.kif_of(r.pv[:12])
        head = "（あなたの手の予想）" if pondering else ""
        self.pv_label.setText(head + " ".join(pv))
        total = r.playouts + r.reused
        self.nodes_label.setText(
            f"{'先読み中 ' if pondering else ''}{total:,} 局面（うち前から引き継ぎ {r.reused:,}）・"
            f"{r.nps:,} 局面/秒・{r.time_ms / 1000:.1f} 秒")

    def closeEvent(self, e) -> None:
        self.engine.stop()
        super().closeEvent(e)
