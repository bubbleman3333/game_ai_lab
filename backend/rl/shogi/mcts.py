"""モンテカルロ木探索（PUCT）。学習したネットの「方策」で有望な手から読み、「価値」で局面を評価する。

AlphaZero / dlshogi と同じ考え方:
    1. 根から、Q（これまでの平均勝率）+ U（方策の確率 × まだ読んでいない度合い）が最大の手をたどる
    2. たどり着いた未展開の局面をネットで評価し、方策（各手の確率）と価値（勝率）を得る
    3. その価値を、たどってきた道に沿って根まで戻しながら足し込む（手番ごとに勝率を反転）
    これを何百〜何千回くり返し、一番たくさん読んだ手を指す。

ネットの評価はまとめて（バッチで）GPU に送ると速いので、「仮の負け（virtual loss）」を使って
1 回に複数の末端を集めてから評価する。
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

import numpy as np
import torch
from cshogi import REPETITION_DRAW, REPETITION_LOSE, REPETITION_SUPERIOR, REPETITION_WIN, Board, move_to_usi
from cshogi.dlshogi import make_move_label

from .data import batch_features
from .model import PolicyValueNet

C_PUCT = 1.5
FPU_REDUCTION = 0.2  # まだ読んでいない手の勝率は「親の勝率 − これ」とみなす
VIRTUAL_LOSS = 1
DRAW_VALUE = 0.5


@dataclass
class Node:
    moves: list[int] = field(default_factory=list)
    prior: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    n: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))  # 各手の訪問回数
    w: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))  # 各手の勝ち数の合計（この局面の手番側から見て）
    children: dict[int, "Node"] = field(default_factory=dict)
    value: float | None = None  # ネットの価値（手番側の勝率）
    terminal: float | None = None  # 終局なら手番側の勝率（0 / 0.5 / 1）

    @property
    def expanded(self) -> bool:
        return self.value is not None or self.terminal is not None


@dataclass
class SearchResult:
    move: str  # USI 形式
    winrate: float  # 指す側から見た勝率の予想
    playouts: int
    time_ms: int
    candidates: list[dict]  # 上位の手（USI・訪問回数・勝率）
    pv: list[str]  # 読み筋


class MCTS:
    def __init__(self, model: PolicyValueNet, device: torch.device, batch_size: int = 32):
        self.model = model
        self.device = device
        self.batch_size = batch_size

    # --- ネットで評価 -------------------------------------------------------------
    @torch.no_grad()
    def _evaluate(self, boards: list[Board], nodes: list[Node]) -> None:
        f1, f2 = batch_features(boards)
        with torch.autocast(self.device.type, enabled=self.device.type == "cuda"):
            logits, value = self.model(f1.to(self.device), f2.to(self.device))
        logits = logits.float().cpu().numpy()
        value = torch.sigmoid(value.float()).cpu().numpy()
        for b, node, lg, v in zip(boards, nodes, logits, value):
            color = b.turn
            labels = [make_move_label(m, color) for m in node.moves]
            x = lg[labels]
            x = np.exp(x - x.max())
            node.prior = (x / x.sum()).astype(np.float32)
            node.value = float(v)

    @staticmethod
    def _prepare(board: Board, node: Node, ply_from_root: int) -> bool:
        """終局判定と合法手の列挙。ネットの評価が要らない（終局）なら True。"""
        rep = board.is_draw(16)
        if ply_from_root > 0 and rep in (REPETITION_DRAW,):
            node.terminal = DRAW_VALUE
            return True
        if ply_from_root > 0 and rep in (REPETITION_WIN, REPETITION_SUPERIOR):
            node.terminal = 1.0
            return True
        if ply_from_root > 0 and rep == REPETITION_LOSE:
            node.terminal = 0.0
            return True
        if board.is_game_over():
            node.terminal = 0.0  # 指す手がない = 手番側の負け
            return True
        if board.is_nyugyoku() or (ply_from_root > 0 and board.mate_move_in_1ply()):
            node.terminal = 1.0  # 宣言勝ち・1 手詰めがある = 手番側の勝ち
            return True
        node.moves = list(board.legal_moves)
        k = len(node.moves)
        node.n = np.zeros(k, np.float32)
        node.w = np.zeros(k, np.float32)
        return False

    # --- 探索 ------------------------------------------------------------------
    def _select(self, node: Node) -> int:
        total = node.n.sum()
        parent_q = node.w.sum() / total if total > 0 else (node.value if node.value is not None else 0.5)
        q = np.where(node.n > 0, node.w / np.maximum(node.n, 1), parent_q - FPU_REDUCTION)
        u = C_PUCT * node.prior * math.sqrt(total + 1) / (1 + node.n)
        return int(np.argmax(q + u))

    def search(self, board: Board, playouts: int = 800, time_limit: float = 0.0) -> SearchResult:
        started = time.time()
        root = Node()
        if self._prepare(board, root, 0):
            raise ValueError("終局しています")
        self._evaluate([board.copy()], [root])
        if len(root.moves) == 1:
            return self._result(root, 1, started)

        done = 0
        while done < playouts and (not time_limit or time.time() - started < time_limit):
            leaves: list[tuple[list[tuple[Node, int]], Node, Board]] = []
            for _ in range(min(self.batch_size, playouts - done)):
                b = board.copy()
                path: list[tuple[Node, int]] = []
                node = root
                while True:
                    if node.terminal is not None:
                        self._backup(path, node.terminal)
                        break
                    if not node.expanded:
                        # まだネットで評価していない局面（このバッチで評価する）
                        leaves.append((path, node, b))
                        break
                    i = self._select(node)
                    path.append((node, i))
                    # 仮の負けを入れて、同じバッチで同じ道ばかり選ばないようにする
                    node.n[i] += VIRTUAL_LOSS
                    b.push(node.moves[i])
                    child = node.children.get(i)
                    if child is None:
                        child = Node()
                        node.children[i] = child
                        self._prepare(b, child, len(path))
                    node = child
                done += 1
            new = [(p, n, b) for p, n, b in leaves if n.value is None]
            if new:
                # 同じ局面が 2 回入ることがあるので、未評価のものだけ評価する
                uniq = {id(n): (n, b) for _, n, b in new}
                self._evaluate([b for _, b in uniq.values()], [n for n, _ in uniq.values()])
            for path, node, _ in leaves:
                self._backup(path, node.value if node.value is not None else DRAW_VALUE)
        return self._result(root, done, started)

    @staticmethod
    def _backup(path: list[tuple[Node, int]], leaf_value: float) -> None:
        """leaf_value は末端の局面の手番側の勝率。1 手さかのぼるごとに反転する。"""
        v = leaf_value
        for node, i in reversed(path):
            v = 1.0 - v  # node の手番側から見た勝率
            node.n[i] += 1 - VIRTUAL_LOSS
            node.w[i] += v

    def _result(self, root: Node, playouts: int, started: float) -> SearchResult:
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
        while node is not None and len(pv) < 12 and len(node.moves):
            pv.append(move_to_usi(node.moves[i]))
            node = node.children.get(i)
            if node is None or not len(node.moves) or node.n.sum() == 0:
                break
            i = int(np.argmax(node.n))
        return SearchResult(move_to_usi(root.moves[best]), winrate, playouts,
                            int((time.time() - started) * 1000), cands, pv)
