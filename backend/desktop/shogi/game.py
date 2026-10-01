"""対局の進行（指し手の記録・待った・終局の判定）。画面（Qt）にも AI にも依存しない。

ルールの判定は cshogi に任せる（合法手・王手・打ち歩詰めなど）。ここで足しているのは、
千日手（同じ局面 4 回）・連続王手の千日手・手数の上限・入玉宣言といった「対局としての決まり」。
"""

from __future__ import annotations

from dataclasses import dataclass

import cshogi
from cshogi import BLACK, KIF, Board

MAX_PLY = 512
SENNICHITE_COUNT = 4  # 同じ局面が 4 回現れたら千日手

# 駒の表示（cshogi の駒の番号 → 漢字）。玉は先手を「玉」、後手を「王」にする
PIECE_KANJI = {1: "歩", 2: "香", 3: "桂", 4: "銀", 5: "角", 6: "飛", 7: "金", 8: "玉",
               9: "と", 10: "杏", 11: "圭", 12: "全", 13: "馬", 14: "龍"}
HAND_ORDER = ["P", "L", "N", "S", "G", "B", "R"]  # cshogi の持ち駒の並び（USI の駒の文字）
HAND_KANJI = ["歩", "香", "桂", "銀", "金", "角", "飛"]


@dataclass
class Result:
    winner: int | None  # cshogi.BLACK / cshogi.WHITE。引き分けは None
    reason: str


def square_usi(file: int, rank: int) -> str:
    """筋 1〜9・段 1〜9 → USI のマス（"7g" など）。"""
    return f"{file}{chr(ord('a') + rank - 1)}"


def square_index(file: int, rank: int) -> int:
    """筋 1〜9・段 1〜9 → cshogi のマスの番号。"""
    return (file - 1) * 9 + (rank - 1)


def usi_squares(usi: str) -> tuple[tuple[int, int] | None, tuple[int, int]]:
    """USI の手 → (動かす元のマス（打つ手は None）, 動かす先のマス)。マスは (筋, 段)。"""
    to = (int(usi[2]), ord(usi[3]) - ord("a") + 1)
    if usi[1] == "*":
        return None, to
    return (int(usi[0]), ord(usi[1]) - ord("a") + 1), to


class Game:
    def __init__(self, sfen: str | None = None):
        self.start_sfen = sfen or cshogi.STARTING_SFEN
        self.board = Board(self.start_sfen)
        self.moves: list[str] = []  # USI
        self.hashes = [self.board.zobrist_hash()]
        self.result: Result | None = None

    # --- 状態 -------------------------------------------------------------------
    @property
    def turn(self) -> int:
        return self.board.turn

    def legal_moves(self) -> set[str]:
        if self.result:
            return set()
        return {cshogi.move_to_usi(m) for m in self.board.legal_moves}

    def can_declare(self) -> bool:
        return not self.result and bool(self.board.is_nyugyoku())

    def kif(self) -> list[str]:
        """棋譜を「▲７六歩(77)」の形で返す。"""
        b = Board(self.start_sfen)
        out, prev = [], None
        for u in self.moves:
            m = b.move_from_usi(u)
            out.append(("▲" if b.turn == BLACK else "△") + KIF.move_to_kif(m, prev))
            b.push(m)
            prev = m
        return out

    def kif_of(self, usis: list[str]) -> list[str]:
        """今の局面からの手順（読み筋など）を棋譜の形にする。"""
        b = self.board.copy()
        out, prev = [], (self.board.peek() if self.moves else None)
        for u in usis:
            m = b.move_from_usi(u)
            if not m or not b.is_legal(m):
                break
            out.append(("▲" if b.turn == BLACK else "△") + KIF.move_to_kif(m, prev))
            b.push(m)
            prev = m
        return out

    # --- 操作 -------------------------------------------------------------------
    def push(self, usi: str) -> None:
        if self.result:
            raise ValueError("対局は終わっています")
        m = self.board.move_from_usi(usi)
        if not m or not self.board.is_legal(m):
            raise ValueError(f"{usi} は指せません")
        self.board.push(m)
        self.moves.append(usi)
        self.hashes.append(self.board.zobrist_hash())
        self._judge()

    def undo(self, n: int = 1) -> None:
        n = min(n, len(self.moves))
        for _ in range(n):
            self.board.pop()
            self.moves.pop()
            self.hashes.pop()
        self.result = None

    def resign(self, color: int) -> None:
        self.result = Result(1 - color, "投了")

    def declare(self) -> bool:
        """手番側の入玉宣言。条件を満たしていれば勝ち。"""
        if not self.can_declare():
            return False
        self.result = Result(self.turn, "入玉宣言")
        return True

    def _judge(self) -> None:
        """直前の手で終局したか調べる。"""
        b = self.board
        side = b.turn  # 次に指す側
        # cshogi の is_draw は 1 回の繰り返しで反応するので、本当の千日手（4 回目）のときだけ使う
        if self.hashes.count(self.hashes[-1]) >= SENNICHITE_COUNT:
            rep = b.is_draw(MAX_PLY)
            if rep == cshogi.REPETITION_LOSE:  # 次に指す側が連続王手をかけていた
                self.result = Result(1 - side, "連続王手の千日手")
            elif rep == cshogi.REPETITION_WIN:
                self.result = Result(side, "連続王手の千日手")
            else:
                self.result = Result(None, "千日手")
        elif b.is_game_over():
            self.result = Result(1 - side, "詰み")
        elif len(self.moves) >= MAX_PLY:
            self.result = Result(None, "手数上限")
