"""hcpe（prepare.py の出力）を読み、ネットの入力と正解を作る。

メモリを節約するため、局面データはファイルを丸ごと読み込まず、必要な 1 件ずつを読む（np.memmap）。
データを作る子プロセスにも「ファイル名と番号」だけを渡すので、プロセスを増やしてもメモリがほとんど増えない。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from cshogi import BLACK, BLACK_WIN, DRAW, Board, HuffmanCodedPosAndEval
from cshogi.dlshogi import FEATURES1_NUM, FEATURES2_NUM, make_input_features, make_move_label


def load_hcpe(paths: list[Path]) -> np.ndarray:
    """小さいデータ（テスト用など）を丸ごと読む。"""
    return np.concatenate([np.fromfile(p, dtype=HuffmanCodedPosAndEval) for p in paths])


def count_hcpe(paths: list[Path]) -> int:
    return sum(p.stat().st_size // HuffmanCodedPosAndEval.itemsize for p in paths)


class HcpeDataset(torch.utils.data.Dataset):
    """1 件 = 1 局面。(features1, features2, 指し手ラベル, 手番側から見た勝敗 0/0.5/1)

    records: 読み込み済みの配列（小さいデータ用）、または paths: hcpe ファイル（大きいデータ用。必要な分だけ読む）
    indices: 使う局面の番号（全ファイルを通した番号）。省略するとすべて。
    """

    def __init__(self, records: np.ndarray | None = None, paths: list[Path] | None = None,
                 indices: np.ndarray | None = None):
        self.records = records
        self.paths = [str(p) for p in (paths or [])]
        sizes = [len(records)] if records is not None else [
            Path(p).stat().st_size // HuffmanCodedPosAndEval.itemsize for p in self.paths]
        self.offsets = np.cumsum([0] + sizes)
        self.indices = indices
        self._maps: list[np.ndarray] | None = None  # 子プロセスの中で開く
        self.board: Board | None = None  # Board は子プロセスへ渡せないので、それぞれで作る

    def __len__(self) -> int:
        return len(self.indices) if self.indices is not None else int(self.offsets[-1])

    def _record(self, i: int):
        if self.indices is not None:
            i = int(self.indices[i])
        if self.records is not None:
            return self.records[i]
        if self._maps is None:
            self._maps = [np.memmap(p, dtype=HuffmanCodedPosAndEval, mode="r") for p in self.paths]
        f = int(np.searchsorted(self.offsets, i, side="right") - 1)
        return self._maps[f][i - self.offsets[f]]

    def __getitem__(self, i: int):
        r = self._record(i)
        if self.board is None:
            self.board = Board()
        b = self.board
        b.set_hcp(np.ascontiguousarray(r["hcp"]))
        f1 = np.zeros((FEATURES1_NUM, 9, 9), np.float32)
        f2 = np.zeros((FEATURES2_NUM, 9, 9), np.float32)
        make_input_features(b, f1, f2)
        move = b.move_from_move16(int(r["bestMove16"]))
        label = make_move_label(move, b.turn)
        result = int(r["gameResult"])
        if result == DRAW:
            value = 0.5
        else:
            black_won = result == BLACK_WIN
            value = 1.0 if black_won == (b.turn == BLACK) else 0.0
        return f1, f2, label, np.float32(value)


def batch_features(boards: list[Board]) -> tuple[torch.Tensor, torch.Tensor]:
    """探索中の局面をまとめてネットに入れるための特徴。"""
    f1 = np.zeros((len(boards), FEATURES1_NUM, 9, 9), np.float32)
    f2 = np.zeros((len(boards), FEATURES2_NUM, 9, 9), np.float32)
    for i, b in enumerate(boards):
        make_input_features(b, f1[i], f2[i])
    return torch.from_numpy(f1), torch.from_numpy(f2)
