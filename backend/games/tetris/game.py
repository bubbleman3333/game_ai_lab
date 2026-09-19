"""1 人分のゲーム状態と操作。時間（重力・ロック遅延）は扱わない。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .board import Board
from .lock import resolve_lock
from .pieces import SPAWN_X, SPAWN_Y, kicks
from .rng import BagRandomizer, Mulberry32
from .rules import SPIN_NONE, detect_spin

GARBAGE_SEED_XOR = 0x9E3779B9
ACTIONS = ("L", "R", "CW", "CCW", "SD", "SDB", "HD", "HOLD")


@dataclass
class ActivePiece:
    type: str
    rot: int = 0
    x: int = SPAWN_X
    y: int = SPAWN_Y


@dataclass
class Stats:
    pieces: int = 0
    lines: int = 0
    attack: int = 0
    sent: int = 0
    tspin_clears: int = 0
    tetrises: int = 0
    perfect_clears: int = 0
    max_combo: int = 0


@dataclass(frozen=True)
class LockResult:
    piece: str
    lines: int
    spin: str
    attack: int  # 相殺前の火力
    sent: int  # 相殺後に相手へ送る段数
    combo: int
    b2b: bool
    b2b_bonus: bool
    perfect_clear: bool
    garbage_received: int  # この固定でせり上がった段数
    game_over: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Game:
    seed: int = 0
    queue_size: int = 5
    board: Board = field(default_factory=Board)
    queue: list[str] = field(default_factory=list)
    current: ActivePiece | None = None
    hold_piece: str | None = None
    can_hold: bool = True
    combo: int = -1
    b2b: bool = False
    pending: list[list[int]] = field(default_factory=list)  # [段数, 穴の列]
    over: bool = False
    stats: Stats = field(default_factory=Stats)
    # 最後に成功した操作が回転なら kick 番号、そうでなければ None（T-Spin 判定用）
    last_kick: int | None = None

    def __post_init__(self) -> None:
        self._bag = BagRandomizer(self.seed)
        self._garbage_rng = Mulberry32(self.seed ^ GARBAGE_SEED_XOR)
        self._fill_queue()
        self._spawn(self._take_next())

    # --- 内部処理 -------------------------------------------------------------
    def _fill_queue(self) -> None:
        while len(self.queue) < self.queue_size + 7:
            self.queue.extend(self._bag.next_bag())

    def _take_next(self) -> str:
        piece = self.queue.pop(0)
        self._fill_queue()
        return piece

    def _spawn(self, piece: str) -> None:
        self.current = ActivePiece(piece)
        self.last_kick = None
        if self.board.collides(piece, 0, SPAWN_X, SPAWN_Y):
            self.over = True

    def _fits(self, rot: int, x: int, y: int) -> bool:
        assert self.current is not None
        return not self.board.collides(self.current.type, rot, x, y)

    # --- 操作 ---------------------------------------------------------------
    @property
    def next_pieces(self) -> list[str]:
        return self.queue[: self.queue_size]

    def move(self, dx: int) -> bool:
        p = self.current
        if self.over or p is None or not self._fits(p.rot, p.x + dx, p.y):
            return False
        p.x += dx
        self.last_kick = None
        return True

    def rotate(self, direction: int) -> bool:
        """direction: +1 で右回転、-1 で左回転。"""
        p = self.current
        if self.over or p is None:
            return False
        to_rot = (p.rot + direction) % 4
        for i, (kx, ky) in enumerate(kicks(p.type, p.rot, to_rot)):
            if self._fits(to_rot, p.x + kx, p.y + ky):
                p.rot, p.x, p.y = to_rot, p.x + kx, p.y + ky
                self.last_kick = i
                return True
        return False

    def soft_drop(self) -> bool:
        p = self.current
        if self.over or p is None or not self._fits(p.rot, p.x, p.y - 1):
            return False
        p.y -= 1
        self.last_kick = None
        return True

    def soft_drop_to_bottom(self) -> int:
        n = 0
        while self.soft_drop():
            n += 1
        return n

    def ghost_y(self) -> int:
        p = self.current
        assert p is not None
        y = p.y
        while self._fits(p.rot, p.x, y - 1):
            y -= 1
        return y

    def hold(self) -> bool:
        if self.over or not self.can_hold or self.current is None:
            return False
        held = self.hold_piece
        self.hold_piece = self.current.type
        self._spawn(held if held is not None else self._take_next())
        self.can_hold = False
        return True

    def hard_drop(self) -> LockResult:
        p = self.current
        assert p is not None and not self.over, "hard_drop はゲーム中にだけ呼べる"
        # 床まで落とす。1 マスでも落ちたら回転扱いではなくなる（soft_drop 内で last_kick=None）。
        self.soft_drop_to_bottom()
        return self._lock()

    def force_current(self, piece: str) -> None:
        """操作中のミノを差し替える（テスト・盤面エディタ用。通常のプレイでは使わない）。"""
        self._spawn(piece)

    def receive_garbage(self, lines: int) -> None:
        """相手からの攻撃を予告に積む。穴の列はここで決める。"""
        if lines > 0:
            self.pending.append([lines, self._garbage_rng.next_int(10)])

    def apply(self, action: str) -> LockResult | bool | int:
        """文字列の操作名で操作する（リプレイ・テスト・AI の経路再生用）。"""
        if action == "L":
            return self.move(-1)
        if action == "R":
            return self.move(1)
        if action == "CW":
            return self.rotate(1)
        if action == "CCW":
            return self.rotate(-1)
        if action == "SD":
            return self.soft_drop()
        if action == "SDB":
            return self.soft_drop_to_bottom()
        if action == "HD":
            return self.hard_drop()
        if action == "HOLD":
            return self.hold()
        raise ValueError(f"unknown action: {action}")

    # --- 固定 ---------------------------------------------------------------
    def _lock(self) -> LockResult:
        p = self.current
        assert p is not None
        spin = detect_spin(self.board, p.type, p.rot, p.x, p.y, self.last_kick)
        out = resolve_lock(self.board, p.type, p.rot, p.x, p.y, spin, self.combo, self.b2b, self.pending)
        self.board, self.combo, self.b2b, self.pending = out.board, out.combo, out.b2b, out.pending

        self._update_stats(p.type, out.lines, spin, out.attack, out.sent, out.perfect_clear)
        self.can_hold = True
        self.over = out.dead
        if not self.over:
            self._spawn(self._take_next())
        if self.over:
            self.current = None

        return LockResult(
            piece=p.type, lines=out.lines, spin=spin, attack=out.attack, sent=out.sent,
            combo=out.combo, b2b=out.b2b, b2b_bonus=out.b2b_bonus,
            perfect_clear=out.perfect_clear, garbage_received=out.garbage_received,
            game_over=self.over,
        )

    def _update_stats(self, piece: str, lines: int, spin: str, attack: int, sent: int, perfect: bool) -> None:
        s = self.stats
        s.pieces += 1
        s.lines += lines
        s.attack += attack
        s.sent += sent
        if lines and spin != SPIN_NONE:
            s.tspin_clears += 1
        if lines == 4:
            s.tetrises += 1
        if perfect:
            s.perfect_clears += 1
        s.max_combo = max(s.max_combo, self.combo)

    # --- シリアライズ -----------------------------------------------------------
    def snapshot(self) -> dict:
        """API・テスト用の状態（JSON にできる形）。"""
        return {
            "rows": list(self.board.rows),
            "current": asdict(self.current) if self.current else None,
            "hold": self.hold_piece,
            "can_hold": self.can_hold,
            "next": self.next_pieces,
            "combo": self.combo,
            "b2b": self.b2b,
            "pending": [list(p) for p in self.pending],
            "over": self.over,
            "stats": asdict(self.stats),
        }
