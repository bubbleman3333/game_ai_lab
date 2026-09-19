"""オセロのルール（ビットボード）。Django・numpy に依存しない。

マス番号 sq = y * 8 + x（x: 列 a〜h = 0〜7、y: 行 1〜8 = 0〜7）。bit sq が 1 ならそこに石がある。
局面は「手番側の石 P」「相手の石 O」「黒番か」で持つ（手番が変わると P と O を入れ替える）。
TypeScript 版（frontend/src/games/othello/engine/board.ts）と同じ結果を出す（shared/fixtures/othello）。
"""

from __future__ import annotations

from dataclasses import dataclass

FULL = (1 << 64) - 1
_NOT_A = 0xFEFEFEFEFEFEFEFE  # a 列（x=0）以外
_NOT_H = 0x7F7F7F7F7F7F7F7F  # h 列（x=7）以外

# (シフト量, シフト後に残してよいマス)。正は左シフト（sq が増える向き）
_DIRS: tuple[tuple[int, int], ...] = (
    (1, _NOT_A),    # 右（x+1）
    (-1, _NOT_H),   # 左
    (8, FULL),      # 下（y+1）
    (-8, FULL),     # 上
    (9, _NOT_A),    # 右下
    (7, _NOT_H),    # 左下
    (-7, _NOT_A),   # 右上
    (-9, _NOT_H),   # 左上
)

INITIAL_BLACK = (1 << (4 * 8 + 3)) | (1 << (3 * 8 + 4))  # d5, e4
INITIAL_WHITE = (1 << (3 * 8 + 3)) | (1 << (4 * 8 + 4))  # d4, e5


def _shift(b: int, s: int, mask: int) -> int:
    return ((b << s) & FULL & mask) if s > 0 else ((b >> -s) & mask)


def legal_moves(P: int, O: int) -> int:
    """手番側が打てるマスのビット集合。"""
    empty = ~(P | O) & FULL
    moves = 0
    for s, mask in _DIRS:
        t = _shift(P, s, mask) & O
        for _ in range(5):
            t |= _shift(t, s, mask) & O
        moves |= _shift(t, s, mask) & empty
    return moves


def flips(P: int, O: int, sq: int) -> int:
    """sq に打ったときに裏返る石のビット集合（0 なら打てない）。"""
    m = 1 << sq
    if (P | O) & m:
        return 0
    result = 0
    for s, mask in _DIRS:
        line = 0
        x = _shift(m, s, mask)
        while x & O:
            line |= x
            x = _shift(x, s, mask)
        if x & P:
            result |= line
    return result


def popcount(b: int) -> int:
    return b.bit_count()


def bits(b: int):
    """立っているビットのマス番号を小さい順に返す。"""
    while b:
        low = b & -b
        yield low.bit_length() - 1
        b ^= low


def sq_to_str(sq: int) -> str:
    return "abcdefgh"[sq % 8] + str(sq // 8 + 1)


def str_to_sq(s: str) -> int:
    x = "abcdefgh".index(s[0].lower())
    y = int(s[1]) - 1
    if not (0 <= y < 8):
        raise ValueError(s)
    return y * 8 + x


@dataclass(frozen=True)
class Position:
    P: int  # 手番側の石
    O: int  # 相手の石
    black_to_move: bool

    @classmethod
    def initial(cls) -> "Position":
        return cls(INITIAL_BLACK, INITIAL_WHITE, True)

    @classmethod
    def from_colors(cls, black: int, white: int, black_to_move: bool) -> "Position":
        return cls(black, white, True) if black_to_move else cls(white, black, False)

    @property
    def black(self) -> int:
        return self.P if self.black_to_move else self.O

    @property
    def white(self) -> int:
        return self.O if self.black_to_move else self.P

    @property
    def empties(self) -> int:
        return 64 - popcount(self.P | self.O)

    def moves(self) -> int:
        return legal_moves(self.P, self.O)

    def play(self, sq: int) -> "Position":
        """sq に打つ。手番は相手に移る（相手がパスかどうかはここでは見ない）。"""
        f = flips(self.P, self.O, sq)
        if not f:
            raise ValueError(f"{sq_to_str(sq)} には打てません")
        return Position(self.O & ~f, self.P | f | (1 << sq), not self.black_to_move)

    def passed(self) -> "Position":
        return Position(self.O, self.P, not self.black_to_move)

    def is_over(self) -> bool:
        return not legal_moves(self.P, self.O) and not legal_moves(self.O, self.P)

    def normalize(self) -> "Position":
        """手番側が打てないが相手は打てるならパスして返す。"""
        if not self.moves() and legal_moves(self.O, self.P):
            return self.passed()
        return self

    def final_score(self) -> int:
        """終局時の石差（手番側から見て）。空きマスは勝った側のものとして数える。"""
        p, o = popcount(self.P), popcount(self.O)
        e = 64 - p - o
        if p > o:
            p += e
        elif o > p:
            o += e
        return p - o

    def to_strings(self) -> list[str]:
        """デバッグ用: 'X' = 黒, 'O' = 白, '.' = 空き。上の行から。"""
        b, w = self.black, self.white
        return [
            "".join("X" if (b >> (y * 8 + x)) & 1 else "O" if (w >> (y * 8 + x)) & 1 else "." for x in range(8))
            for y in range(8)
        ]


def play_moves(moves: str) -> Position:
    """"f5d6c3..." の棋譜を最初から再生する（パスは自動）。不正な手があれば ValueError。"""
    pos = Position.initial()
    for i in range(0, len(moves), 2):
        pos = pos.normalize()
        if pos.is_over():
            raise ValueError(f"{i // 2 + 1} 手目: 終局後の手です")
        pos = pos.play(str_to_sq(moves[i : i + 2]))
    return pos.normalize()
