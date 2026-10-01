"""将棋盤の表示と、クリックで指す操作。

盤の向き: 人が先手なら先手を下に、後手なら後手を下にする（flipped）。
画面のマス (列 c, 行 r)（左上が 0, 0）と、将棋のマス (筋, 段) の対応:
    そのまま: 筋 = 9 - c, 段 = r + 1      反転: 筋 = c + 1, 段 = 9 - r
駒は五角形を描いて漢字を書く（画像は使わない）。上側の駒は 180 度回して描く。
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QMessageBox, QWidget
from cshogi import BLACK, WHITE

from .game import HAND_KANJI, HAND_ORDER, PIECE_KANJI, Game, square_index, square_usi, usi_squares

KANJI_NUM = "〇一二三四五六七八九"
ZEN_NUM = "０１２３４５６７８９"

COL_BOARD = QColor("#e6c27a")
COL_BOARD_EDGE = QColor("#8a5a2b")
COL_LINE = QColor("#3b2a14")
COL_PIECE = QColor("#f7e7c1")
COL_PIECE_EDGE = QColor("#7a5a30")
COL_TEXT = QColor("#1b1209")
COL_PROMOTED = QColor("#c0251c")
COL_LAST = QColor(255, 140, 0, 90)
COL_SELECT = QColor(40, 120, 255, 110)
COL_TARGET = QColor(40, 120, 255, 150)
COL_CHECK = QColor(220, 30, 30, 110)


class BoardView(QWidget):
    move_made = Signal(str)  # 人が指した手（USI）

    def __init__(self, parent=None):
        super().__init__(parent)
        self.game: Game | None = None
        self.flipped = False
        self.interactive = False
        self.selected: tuple | None = None  # ("sq", 筋, 段) / ("hand", "P")
        self.targets: set[tuple[int, int]] = set()
        self._legal: set[str] = set()
        self.setMinimumSize(480, 560)
        self.setMouseTracking(False)

    # --- 外から呼ぶ -------------------------------------------------------------
    def set_game(self, game: Game, flipped: bool) -> None:
        self.game, self.flipped = game, flipped
        self.refresh()

    def set_interactive(self, on: bool) -> None:
        self.interactive = on
        self.refresh()

    def refresh(self) -> None:
        self.selected, self.targets = None, set()
        self._legal = self.game.legal_moves() if (self.game and self.interactive) else set()
        self.update()

    # --- 座標 -------------------------------------------------------------------
    def _geometry(self) -> tuple[float, float, float, float]:
        """(マスの大きさ, 盤の左, 盤の上, 持ち駒の段の高さ)"""
        w, h = self.width(), self.height()
        cell = min((w - 8) / 9.8, (h - 8) / (9 + 2 * 1.25 + 0.9))
        hand_h = cell * 1.05
        bw = cell * 9
        left = (w - bw) / 2
        top = (h - (bw + 2 * hand_h + cell * 0.6)) / 2 + hand_h + cell * 0.35
        return cell, left, top, hand_h

    def _to_screen(self, file: int, rank: int) -> tuple[int, int]:
        return (file - 1, 9 - rank) if self.flipped else (9 - file, rank - 1)

    def _from_screen(self, c: int, r: int) -> tuple[int, int]:
        return (c + 1, 9 - r) if self.flipped else (9 - c, r + 1)

    def _cell_rect(self, file: int, rank: int) -> QRectF:
        cell, left, top, _ = self._geometry()
        c, r = self._to_screen(file, rank)
        return QRectF(left + c * cell, top + r * cell, cell, cell)

    def _bottom_color(self) -> int:
        return WHITE if self.flipped else BLACK

    def _hand_slots(self, color: int) -> list[tuple[QRectF, int]]:
        """持ち駒を置く枠（駒の種類ごと）。下側は盤の下、上側は盤の上。"""
        cell, left, top, hand_h = self._geometry()
        y = top + 9 * cell + cell * 0.25 if color == self._bottom_color() else top - cell * 0.25 - hand_h
        slot_w = 9 * cell / 7
        order = range(7) if color == self._bottom_color() else reversed(range(7))
        return [(QRectF(left + k * slot_w, y, slot_w, hand_h), i) for k, i in enumerate(order)]

    # --- 描画 -------------------------------------------------------------------
    def paintEvent(self, _event) -> None:
        if self.game is None:
            return
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.fillRect(self.rect(), QColor("#2b2f36"))
        cell, left, top, hand_h = self._geometry()
        board = self.game.board

        # 盤
        p.setPen(QPen(COL_BOARD_EDGE, 2))
        p.setBrush(COL_BOARD)
        p.drawRoundedRect(QRectF(left - cell * 0.3, top - cell * 0.3, cell * 9.6, cell * 9.6), 6, 6)
        # 直前の手・選択・王手
        if self.game.moves:
            _, to = usi_squares(self.game.moves[-1])
            p.fillRect(self._cell_rect(*to), COL_LAST)
        if self.selected and self.selected[0] == "sq":
            p.fillRect(self._cell_rect(self.selected[1], self.selected[2]), COL_SELECT)
        if board.is_check():
            king = board.king_square(board.turn)
            p.fillRect(self._cell_rect(king // 9 + 1, king % 9 + 1), COL_CHECK)
        # 線
        p.setPen(QPen(COL_LINE, 1.2))
        for k in range(10):
            p.drawLine(QPointF(left + k * cell, top), QPointF(left + k * cell, top + 9 * cell))
            p.drawLine(QPointF(left, top + k * cell), QPointF(left + 9 * cell, top + k * cell))
        p.setBrush(COL_LINE)
        for sx in (3, 6):
            for sy in (3, 6):
                p.drawEllipse(QPointF(left + sx * cell, top + sy * cell), cell * 0.05, cell * 0.05)
        # 筋・段の数字
        p.setPen(QColor("#5a3d1c"))
        f = QFont("Yu Gothic UI", max(7, int(cell * 0.18)), QFont.Bold)
        p.setFont(f)
        for c in range(9):
            file, _ = self._from_screen(c, 0)
            p.drawText(QRectF(left + c * cell, top - cell * 0.3, cell, cell * 0.3), Qt.AlignCenter, ZEN_NUM[file])
        for r in range(9):
            _, rank = self._from_screen(0, r)
            p.drawText(QRectF(left + 9 * cell, top + r * cell, cell * 0.3, cell), Qt.AlignCenter, KANJI_NUM[rank])

        # 駒
        pieces = board.pieces
        for file in range(1, 10):
            for rank in range(1, 10):
                pc = pieces[square_index(file, rank)]
                if pc:
                    color = WHITE if pc >= 16 else BLACK
                    kind = pc - 16 if pc >= 16 else pc
                    self._draw_piece(p, self._cell_rect(file, rank), kind, color, cell)
        # 動かせる先
        p.setPen(Qt.NoPen)
        p.setBrush(COL_TARGET)
        for t in self.targets:
            rc = self._cell_rect(*t)
            p.drawEllipse(rc.center(), cell * 0.13, cell * 0.13)

        # 持ち駒
        hands = board.pieces_in_hand
        for color in (BLACK, WHITE):
            mark = "☗" if color == BLACK else "☖"
            slots = self._hand_slots(color)
            area = QRectF(slots[0][0].left(), slots[0][0].top(), 9 * cell, hand_h)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor("#3a3f48"))
            p.drawRoundedRect(area.adjusted(-cell * 0.3, 0, cell * 0.3, 0), 6, 6)
            p.setPen(QColor("#e0d2b4"))
            p.setFont(QFont("Yu Gothic UI", max(7, int(cell * 0.22))))
            label_x = area.left() - cell * 0.3 - cell * 0.45
            p.drawText(QRectF(label_x, area.top(), cell * 0.45, hand_h), Qt.AlignCenter, mark)
            for rect, i in slots:
                n = hands[color][i]
                if not n:
                    continue
                if self.selected == ("hand", HAND_ORDER[i]) and color == board.turn:
                    p.fillRect(rect, COL_SELECT)
                kind = [1, 2, 3, 4, 7, 5, 6][i]
                pr = QRectF(rect.center().x() - cell / 2, rect.top() + (hand_h - cell) / 2, cell, cell)
                self._draw_piece(p, pr, kind, color, cell)
                if n > 1:
                    p.setPen(QColor("#ffffff"))
                    p.setFont(QFont("Yu Gothic UI", max(7, int(cell * 0.24)), QFont.Bold))
                    p.drawText(QRectF(pr.right() - cell * 0.12, pr.top(), cell * 0.4, cell * 0.4), Qt.AlignCenter, str(n))
        p.end()

    def _draw_piece(self, p: QPainter, rect: QRectF, kind: int, color: int, cell: float) -> None:
        upside_down = (color == WHITE) != self.flipped
        p.save()
        p.translate(rect.center())
        if upside_down:
            p.rotate(180)
        w, h = cell * 0.78, cell * 0.88
        poly = QPolygonF([QPointF(0, -h / 2), QPointF(w * 0.38, -h * 0.33), QPointF(w / 2, h / 2),
                          QPointF(-w / 2, h / 2), QPointF(-w * 0.38, -h * 0.33)])
        p.setPen(QPen(COL_PIECE_EDGE, 1.2))
        p.setBrush(QBrush(COL_PIECE))
        p.drawPolygon(poly)
        text = PIECE_KANJI[kind]
        if kind == 8 and color == WHITE:
            text = "王"
        p.setPen(COL_PROMOTED if kind >= 9 else COL_TEXT)
        p.setFont(QFont("Yu Mincho", max(8, int(cell * 0.42)), QFont.Bold))
        p.drawText(QRectF(-w / 2, -h / 2 + h * 0.08, w, h), Qt.AlignCenter, text)
        p.restore()

    # --- 操作 -------------------------------------------------------------------
    def _hit(self, x: float, y: float):
        cell, left, top, _ = self._geometry()
        if left <= x < left + 9 * cell and top <= y < top + 9 * cell:
            return ("sq", *self._from_screen(int((x - left) // cell), int((y - top) // cell)))
        for rect, i in self._hand_slots(self.game.turn):
            if rect.contains(QPointF(x, y)):
                return ("hand", HAND_ORDER[i])
        return None

    def mousePressEvent(self, event) -> None:
        if not (self.interactive and self.game) or event.button() != Qt.LeftButton:
            return
        hit = self._hit(event.position().x(), event.position().y())
        if hit is None:
            self.selected, self.targets = None, set()
            self.update()
            return
        if hit[0] == "sq" and self.selected and (hit[1], hit[2]) in self.targets:
            self._finish_move((hit[1], hit[2]))
            return
        moves = self._moves_from(hit)
        if moves:
            self.selected = hit
            self.targets = {usi_squares(u)[1] for u in moves}
        else:
            self.selected, self.targets = None, set()
        self.update()

    def _moves_from(self, hit) -> list[str]:
        if hit[0] == "hand":
            return [u for u in self._legal if u.startswith(hit[1] + "*")]
        src = square_usi(hit[1], hit[2])
        return [u for u in self._legal if u[:2] == src]

    def _finish_move(self, to: tuple[int, int]) -> None:
        dest = square_usi(*to)
        cands = [u for u in self._moves_from(self.selected) if u[2:4] == dest]
        if len(cands) > 1:  # 成る・成らないの両方がある
            ans = QMessageBox.question(self, "成り", "成りますか？", QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
            usi = next(u for u in cands if u.endswith("+") == (ans == QMessageBox.Yes))
        else:
            usi = cands[0]
        self.selected, self.targets = None, set()
        self.move_made.emit(usi)
