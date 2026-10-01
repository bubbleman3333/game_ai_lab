"""探索中の局面をまとめてネットで評価する。

GPU ではネットを半精度（fp16）にし、CUDA グラフに「録画」しておく。
普通に呼ぶと層ごとに GPU へ命令を送るので、小さいバッチでは命令を送る手間のほうが計算より長い。
録画しておけば 1 回の命令で全部の層が流れる（同じ大きさの入力にしか使えないので、大きさごとに録画する）。

入出力の置き場（slot）を 2 組持ち、GPU が 1 組目を計算している間に CPU が次のバッチを集められるようにする
（submit で投げて、あとで result で受け取る）。
"""

from __future__ import annotations

import copy

import numpy as np
import torch
from cshogi import Board
from cshogi.dlshogi import FEATURES1_NUM, FEATURES2_NUM, make_input_features, make_move_label

from .model import PolicyValueNet

BUCKETS = (1, 8, 16, 32, 64, 128, 256)  # 録画しておくバッチの大きさ
SLOTS = 2


class _Slot:
    """1 バッチ分の入出力の置き場と、その大きさごとの録画。"""

    def __init__(self, ev: "Evaluator"):
        mb, dev = ev.max_batch, ev.device
        # 入力は「ページ固定メモリ」に作る（GPU の計算を待たずに転送できる）。numpy からはそのまま書ける
        self.pin1 = torch.zeros((mb, FEATURES1_NUM, 9, 9), dtype=torch.float32).pin_memory()
        self.pin2 = torch.zeros((mb, FEATURES2_NUM, 9, 9), dtype=torch.float32).pin_memory()
        self.f1, self.f2 = self.pin1.numpy(), self.pin2.numpy()
        self.in1 = torch.zeros((mb, FEATURES1_NUM, 9, 9), dtype=torch.half, device=dev)
        self.in2 = torch.zeros((mb, FEATURES2_NUM, 9, 9), dtype=torch.half, device=dev)
        self.out_logits = torch.zeros((mb, ev.policy_size), dtype=torch.half).pin_memory()
        self.out_value = torch.zeros(mb, dtype=torch.half).pin_memory()
        self.done = torch.cuda.Event()
        self.graphs: dict[int, tuple[torch.cuda.CUDAGraph, torch.Tensor, torch.Tensor]] = {}
        for size in BUCKETS:
            if size > mb:
                break
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g):
                logits, value = ev._forward(self.in1[:size], self.in2[:size])
            self.graphs[size] = (g, logits, value)


class Pending:
    """GPU で計算中のバッチ。result() で結果を受け取る。"""

    def __init__(self, ev: "Evaluator", slot: _Slot | None, boards: list[Board], moves: list[list[int]], n: int,
                 cpu_out: tuple[np.ndarray, np.ndarray] | None = None):
        self.ev, self.slot, self.boards, self.moves, self.n, self.cpu_out = ev, slot, boards, moves, n, cpu_out

    def result(self) -> tuple[list[np.ndarray], list[float]]:
        if self.cpu_out is not None:
            logits, value = self.cpu_out
        else:
            self.slot.done.synchronize()
            logits = self.slot.out_logits[:self.n].numpy().astype(np.float32)
            value = self.slot.out_value[:self.n].numpy().astype(np.float32)
        priors, values = [], []
        for b, mv, lg, v in zip(self.boards, self.moves, logits, value):
            color = b.turn
            x = lg[[make_move_label(m, color) for m in mv]]
            x = np.exp(x - x.max())
            priors.append((x / x.sum()).astype(np.float32))
            values.append(float(v))
        return priors, values


class Evaluator:
    def __init__(self, model: PolicyValueNet, device: torch.device, max_batch: int = 64):
        self.device = device
        self.max_batch = max_batch
        self.policy_size = model.policy_bias.numel()
        self._next = 0
        if device.type == "cuda":
            self.net = copy.deepcopy(model).half().eval()
            self._warmup()
            self.slots = [_Slot(self) for _ in range(SLOTS)]
        else:
            self.net = model.eval()
            self.slots = []
            self.f1 = np.zeros((max_batch, FEATURES1_NUM, 9, 9), np.float32)
            self.f2 = np.zeros((max_batch, FEATURES2_NUM, 9, 9), np.float32)

    @torch.no_grad()
    def _forward(self, a: torch.Tensor, b: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        logits, value = self.net(a, b)
        return logits, torch.sigmoid(value)

    @torch.no_grad()
    def _warmup(self) -> None:
        """録画の前に何回か流して、内部の準備（畳み込みのアルゴリズムの選択など）を済ませる。"""
        a = torch.zeros((self.max_batch, FEATURES1_NUM, 9, 9), dtype=torch.half, device=self.device)
        b = torch.zeros((self.max_batch, FEATURES2_NUM, 9, 9), dtype=torch.half, device=self.device)
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for size in BUCKETS:
                if size <= self.max_batch:
                    for _ in range(2):
                        self._forward(a[:size], b[:size])
        torch.cuda.current_stream().wait_stream(side)
        torch.cuda.synchronize()

    @torch.no_grad()
    def submit(self, boards: list[Board], moves: list[list[int]]) -> Pending:
        """評価を GPU に投げる（結果を待たずに戻る）。1 回に max_batch 局面まで。"""
        n = len(boards)
        assert 0 < n <= self.max_batch
        if not self.slots:  # CPU
            self.f1[:n] = 0
            self.f2[:n] = 0
            for i, b in enumerate(boards):
                make_input_features(b, self.f1[i], self.f2[i])
            logits, value = self._forward(torch.from_numpy(self.f1[:n]), torch.from_numpy(self.f2[:n]))
            return Pending(self, None, boards, moves, n, (logits.numpy(), value.numpy()))
        slot = self.slots[self._next]
        self._next = (self._next + 1) % len(self.slots)
        slot.done.synchronize()  # この置き場の前のバッチが読み終わっていること
        slot.f1[:n] = 0
        slot.f2[:n] = 0
        for i, b in enumerate(boards):
            make_input_features(b, slot.f1[i], slot.f2[i])
        size = next(s for s in slot.graphs if s >= n)
        slot.in1[:n].copy_(slot.pin1[:n], non_blocking=True)
        slot.in2[:n].copy_(slot.pin2[:n], non_blocking=True)
        g, logits, value = slot.graphs[size]
        g.replay()
        slot.out_logits[:n].copy_(logits[:n], non_blocking=True)
        slot.out_value[:n].copy_(value[:n], non_blocking=True)
        slot.done.record()
        return Pending(self, slot, boards, moves, n)

    def evaluate(self, boards: list[Board], moves: list[list[int]]) -> tuple[list[np.ndarray], list[float]]:
        """各局面の合法手の確率（方策）と、手番側の勝率（価値）を返す（待って受け取る）。"""
        priors: list[np.ndarray] = []
        values: list[float] = []
        for start in range(0, len(boards), self.max_batch):
            p, v = self.submit(boards[start:start + self.max_batch], moves[start:start + self.max_batch]).result()
            priors += p
            values += v
        return priors, values
