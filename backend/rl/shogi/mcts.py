"""モンテカルロ木探索（PUCT）。学習したネットの「方策」で有望な手から読み、「価値」で局面を評価する。

AlphaZero / dlshogi と同じ考え方:
    1. 根から、Q（これまでの平均勝率）+ U（方策の確率 × まだ読んでいない度合い）が最大の手をたどる
    2. たどり着いた未展開の局面をネットで評価し、方策（各手の確率）と価値（勝率）を得る
    3. その価値を、たどってきた道に沿って根まで戻しながら足し込む（手番ごとに勝率を反転）
    これを何千〜何万回くり返し、一番たくさん読んだ手を指す。

速くするための工夫（Python で書いているので、1 回あたりの手間を削るのが効く）:
    - ネットの評価はまとめて（バッチで）GPU に送る。「仮の負け（virtual loss）」で 1 回に複数の末端を集める
    - GPU への命令は CUDA グラフにまとめて 1 回で送る（evaluator.py）
    - どの手を読むかの計算（_select）は numba で機械語にする
    - 前の探索の木を捨てずに使う（相手が指した手の先の部分木をそのまま根にする）。
      相手の考慮中に読んでおく（先読み・ponder）と、その分がそのまま次の手に効く
    - 末端では 3 手詰めを調べ、根では別プロセスで長い詰み（df-pn）を探す（mate.py）
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import torch
from cshogi import REPETITION_DRAW, REPETITION_LOSE, REPETITION_SUPERIOR, REPETITION_WIN, Board, move_to_usi
from numba import njit

from . import mate
from .evaluator import Evaluator
from .model import PolicyValueNet

C_PUCT = 1.5
FPU_REDUCTION = 0.2  # まだ読んでいない手の勝率は「親の勝率 − これ」とみなす
VIRTUAL_LOSS = 1  # 1 から変えるときは _backup で訪問回数を直すこと
DRAW_VALUE = 0.5
LEAF_MATE_PLY = 3  # 末端で調べる詰みの手数（奇数）
MAX_TREE_VISITS = 500_000  # 木がこれ以上大きくなったら読むのをやめる（1 局面あたり約 1.6KB。50 万で約 800MB）


@dataclass(slots=True)
class Node:
    moves: np.ndarray = field(default_factory=lambda: np.zeros(0, np.uint32))  # 合法手（Python の int の list より 1/8 の大きさ）
    prior: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    n: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))  # 各手の訪問回数
    w: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))  # 各手の勝ち数の合計（この局面の手番側から見て）
    children: dict[int, "Node"] = field(default_factory=dict)
    value: float | None = None  # ネットの価値（手番側の勝率）
    terminal: float | None = None  # 終局なら手番側の勝率（0 / 0.5 / 1）
    pending: bool = False  # GPU で評価中

    @property
    def expanded(self) -> bool:
        return self.value is not None or self.terminal is not None


@dataclass
class SearchResult:
    move: str  # USI 形式（入玉宣言で勝てるときは "win"）
    winrate: float  # 指す側から見た勝率の予想
    playouts: int
    time_ms: int
    candidates: list[dict]  # 上位の手（USI・訪問回数・勝率）
    pv: list[str]  # 読み筋
    mate: bool = False  # 詰みを読み切った手
    reused: int = 0  # 前の探索から引き継いだ訪問回数

    @property
    def nps(self) -> int:
        return int(self.playouts * 1000 / max(1, self.time_ms))


@dataclass
class _Batch:
    leaves: list  # (たどった道, 末端) の並び
    nodes: list  # このバッチで評価する局面
    pending: object  # evaluator.Pending（評価する局面が無ければ None）


@njit(cache=True)
def _select_nb(n: np.ndarray, w: np.ndarray, prior: np.ndarray, value: float) -> int:
    total = 0.0
    wsum = 0.0
    for i in range(len(n)):
        total += n[i]
        wsum += w[i]
    parent_q = wsum / total if total > 0 else value
    sq = math.sqrt(total + 1.0)
    best, best_i = -1e9, 0
    for i in range(len(n)):
        q = w[i] / n[i] if n[i] > 0 else parent_q - FPU_REDUCTION
        s = q + C_PUCT * prior[i] * sq / (1.0 + n[i])
        if s > best:
            best, best_i = s, i
    return best_i


class MCTS:
    def __init__(self, model: PolicyValueNet, device: torch.device, batch_size: int = 64):
        self.evaluator = Evaluator(model, device, batch_size)
        self.batch_size = batch_size
        self._tree: tuple[int, str, Node] | None = None  # (根の局面のハッシュ, 根の sfen, 根)。次の探索で使い回す
        self._lock = threading.Lock()  # 探索は同時に 1 つだけ

    # --- ネットで評価 -------------------------------------------------------------
    def _evaluate(self, boards: list[Board], nodes: list[Node]) -> None:
        priors, values = self.evaluator.evaluate(boards, [n.moves for n in nodes])
        for node, p, v in zip(nodes, priors, values):
            node.prior = p
            node.value = v

    @staticmethod
    def _prepare(board: Board, node: Node, ply_from_root: int) -> bool:
        """終局判定と合法手の列挙。ネットの評価が要らない（終局）なら True。"""
        if ply_from_root > 0:
            rep = board.is_draw(16)
            if rep == REPETITION_DRAW:
                node.terminal = DRAW_VALUE
                return True
            if rep in (REPETITION_WIN, REPETITION_SUPERIOR):
                node.terminal = 1.0
                return True
            if rep == REPETITION_LOSE:
                node.terminal = 0.0
                return True
        moves = np.fromiter(board.legal_moves, np.uint32)
        if not len(moves):
            node.terminal = 0.0  # 指す手がない = 手番側の負け
            return True
        if board.is_nyugyoku() or (ply_from_root > 0 and not board.is_check() and board.mate_move(LEAF_MATE_PLY)):
            node.terminal = 1.0  # 宣言勝ち・短い詰みがある = 手番側の勝ち
            return True
        node.moves = moves
        k = len(moves)
        node.n = np.zeros(k, np.float32)
        node.w = np.zeros(k, np.float32)
        return False

    @staticmethod
    def _select(node: Node) -> int:
        return int(_select_nb(node.n, node.w, node.prior, node.value if node.value is not None else 0.5))

    # --- 木の使い回し -----------------------------------------------------------
    def _reuse_root(self, board: Board) -> Node | None:
        """前の探索の木の中に今の局面があれば（2 手先まで）、その部分木を返す。"""
        if self._tree is None:
            return None
        key = board.zobrist_hash()
        root_key, root_sfen, root = self._tree
        if root_key == key:
            return root
        b = Board(root_sfen)
        for i, child in root.children.items():
            b.push(root.moves[i])
            if b.zobrist_hash() == key:
                return child
            for j, grand in child.children.items():
                b.push(child.moves[j])
                hit = b.zobrist_hash() == key
                b.pop()
                if hit:
                    return grand
            b.pop()
        return None

    def clear(self) -> None:
        """木を捨てる（新しい対局のはじめなど）。"""
        self._tree = None

    # --- 探索 ------------------------------------------------------------------
    def search(self, board: Board, playouts: int = 800, time_limit: float = 0.0,
               stop: threading.Event | None = None, on_progress: Callable[[SearchResult], None] | None = None,
               progress_every: float = 0.3, mate_search: bool = True, reuse: bool = True) -> SearchResult:
        """playouts 回読むか time_limit 秒たつか stop が立つまで読む（time_limit=0 は時間で止めない）。

        on_progress を渡すと、途中経過（読み筋や勝率）を progress_every 秒ごとに呼ぶ（画面の表示用）。
        """
        with self._lock:
            return self._search(board, playouts, time_limit, stop, on_progress, progress_every, mate_search, reuse)

    def _search(self, board, playouts, time_limit, stop, on_progress, progress_every, mate_search, reuse):
        started = time.time()
        board = board.copy()
        if board.is_nyugyoku():
            return SearchResult("win", 1.0, 0, 0, [], [], mate=True)
        root = self._reuse_root(board) if reuse else None
        if root is None or root.terminal is not None or not root.expanded:
            root = Node()
            if self._prepare(board, root, 0):
                raise ValueError("終局しています")
            self._evaluate([board], [root])
        reused = int(root.n.sum())
        self._tree = (board.zobrist_hash(), board.sfen(), root)
        if len(root.moves) == 1:
            return self._result(root, 0, started, reused)

        mate_job = None
        if mate_search:
            mate_job = mate.start(board.sfen(), time_limit if time_limit else 5.0)

        done = 0
        last_progress = started
        stopped_early = False
        inflight: deque[_Batch] = deque()  # GPU で計算中のバッチ（計算中に次のバッチを集める）
        while done < playouts and reused + done < MAX_TREE_VISITS:
            now = time.time()
            if (time_limit and now - started >= time_limit) or (stop is not None and stop.is_set()):
                break
            if mate_job is not None and mate_job.done():
                pv = mate_job.result()
                mate_job = None
                if pv:  # 詰みを読み切った
                    self._drain(inflight)
                    return self._mate_result(root, pv, done, started, reused)
            if time_limit and done > 2000 and self._decided(root, done, now - started, time_limit):
                stopped_early = True
                break
            if on_progress and now - last_progress >= progress_every:
                last_progress = now
                on_progress(self._result(root, done, started, reused))
            count = min(self.batch_size, playouts - done)
            inflight.append(self._collect(board, root, count))
            done += count
            if len(inflight) >= 2:
                self._finish(inflight.popleft())
        self._drain(inflight)
        if mate_job is not None:
            pv = mate.finish(mate_job)
            if pv:
                return self._mate_result(root, pv, done, started, reused)
        r = self._result(root, done, started, reused)
        r.stopped_early = stopped_early  # type: ignore[attr-defined]
        return r

    @staticmethod
    def _decided(root: Node, done: int, elapsed: float, time_limit: float) -> bool:
        """残り時間で読める回数を全部 2 番目の手に足しても 1 番を抜けないなら、もう読まなくてよい。"""
        if root.n.size < 2:
            return True
        top2 = np.partition(root.n, -2)[-2:]
        remaining = done / max(elapsed, 1e-3) * (time_limit - elapsed)
        return top2[1] - top2[0] > remaining

    def _collect(self, board: Board, root: Node, count: int) -> "_Batch":
        """根から count 回たどって末端を集め、まだ評価していない局面を GPU に投げる。"""
        leaves: list[tuple[list[tuple[Node, int]], Node]] = []
        new_nodes: list[Node] = []
        new_boards: list[Board] = []
        for _ in range(count):
            b = board.copy()
            path: list[tuple[Node, int]] = []
            node = root
            while True:
                if node.terminal is not None:
                    self._backup(path, node.terminal)
                    break
                if not node.expanded:
                    # まだネットで評価していない局面。前のバッチで評価中（pending）なら、その結果を待って使う
                    leaves.append((path, node))
                    if not node.pending:
                        node.pending = True
                        new_nodes.append(node)
                        new_boards.append(b)
                    break
                i = self._select(node)
                path.append((node, i))
                node.n[i] += VIRTUAL_LOSS  # 仮の負けを入れて、同じバッチで同じ道ばかり選ばないようにする
                b.push(node.moves[i])
                child = node.children.get(i)
                if child is None:
                    child = Node()
                    node.children[i] = child
                    self._prepare(b, child, len(path))
                node = child
        pending = self.evaluator.submit(new_boards, [n.moves for n in new_nodes]) if new_nodes else None
        return _Batch(leaves, new_nodes, pending)

    def _finish(self, batch: "_Batch") -> None:
        if batch.pending is not None:
            priors, values = batch.pending.result()
            for node, p, v in zip(batch.nodes, priors, values):
                node.prior, node.value, node.pending = p, v, False
        for path, node in batch.leaves:
            self._backup(path, node.value if node.value is not None else DRAW_VALUE)

    def _drain(self, inflight: "deque[_Batch]") -> None:
        while inflight:
            self._finish(inflight.popleft())

    @staticmethod
    def _backup(path: list[tuple[Node, int]], leaf_value: float) -> None:
        """leaf_value は末端の局面の手番側の勝率。1 手さかのぼるごとに反転する。"""
        v = leaf_value
        for node, i in reversed(path):
            v = 1.0 - v  # node の手番側から見た勝率
            node.w[i] += v  # 訪問回数は、たどったときに仮の負けとして 1 足してある（VIRTUAL_LOSS = 1）

    def _mate_result(self, root: Node, pv: list[str], playouts: int, started: float, reused: int) -> SearchResult:
        r = self._result(root, playouts, started, reused)
        r.move, r.winrate, r.pv, r.mate = pv[0], 1.0, pv, True
        return r

    def _result(self, root: Node, playouts: int, started: float, reused: int = 0) -> SearchResult:
        order = np.argsort(-root.n) if root.n.sum() > 0 else np.argsort(-root.prior)
        best = int(order[0])
        # 探索しなかった（合法手が 1 つ）ときは、ネットの価値（手番側 = 指す側の勝率）をそのまま使う
        winrate = float(root.w[best] / root.n[best]) if root.n[best] > 0 else (
            root.value if root.value is not None else 0.5)
        cands = [
            {"move": move_to_usi(root.moves[i]), "visits": int(root.n[i]),
             "winrate": float(root.w[i] / root.n[i]) if root.n[i] > 0 else None, "prior": float(root.prior[i])}
            for i in order[:5]
        ]
        pv = []
        node, i = root, best
        while node is not None and len(pv) < 16 and len(node.moves):
            pv.append(move_to_usi(node.moves[i]))
            node = node.children.get(i)
            if node is None or not len(node.moves) or node.n.sum() == 0:
                break
            i = int(np.argmax(node.n))
        return SearchResult(move_to_usi(root.moves[best]), winrate, playouts,
                            int((time.time() - started) * 1000), cands, pv, reused=reused)
