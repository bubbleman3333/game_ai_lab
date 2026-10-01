"""将棋の探索（rl/shogi/mcts.py・mate.py）とデスクトップアプリの対局の進行（desktop/shogi/game.py）のテスト。

ネットは学習していない小さいもの（CPU）を使う。強さではなく、決まりどおりに動くかを見る。
"""

import cshogi
import pytest
import torch

from desktop.shogi.game import Game
from rl.shogi import mate
from rl.shogi.mcts import MCTS
from rl.shogi.model import PolicyValueNet

MATE_IN_1 = "4k4/9/4P4/9/9/9/9/9/4K4 b G 1"  # ▲５二金打で詰み


@pytest.fixture(scope="module")
def searcher():
    torch.manual_seed(0)
    return MCTS(PolicyValueNet(blocks=1, channels=16).eval(), torch.device("cpu"), batch_size=8)


def test_search_returns_legal_move(searcher):
    b = cshogi.Board()
    r = searcher.search(b, playouts=64, mate_search=False, reuse=False)
    assert r.move in {cshogi.move_to_usi(m) for m in b.legal_moves}
    assert r.playouts == 64 and 0 <= r.winrate <= 1 and r.pv[0] == r.move


def test_search_finds_mate_in_one(searcher):
    # 1 手詰めの手の先は「相手に指す手がない」終局なので、学習していないネットでも必ずそれを選ぶ
    r = searcher.search(cshogi.Board(MATE_IN_1), playouts=300, mate_search=False, reuse=False)
    assert r.move == "G*5b"


def test_tree_is_reused_after_opponent_move(searcher):
    b = cshogi.Board()
    searcher.clear()
    searcher.search(b, playouts=400, mate_search=False)
    b.push_usi("7g7f")
    r = searcher.search(b, playouts=8, mate_search=False)
    assert r.reused > 0  # 7g7f の先を読んでいた分を引き継ぐ


def test_dfpn_finds_mate():
    assert mate._solve(MATE_IN_1, 10_000) == ["G*5b"]
    assert mate._solve(cshogi.STARTING_SFEN, 10_000) == []


def test_game_mate_and_undo():
    g = Game(MATE_IN_1)
    g.push("G*5b")
    assert g.result and g.result.winner == cshogi.BLACK and g.result.reason == "詰み"
    g.undo(1)
    assert g.result is None and "G*5b" in g.legal_moves()


def test_game_sennichite():
    g = Game()
    for _ in range(3):
        for u in ("5i5h", "5a5b", "5h5i", "5b5a"):
            g.push(u)
    assert g.result and g.result.winner is None and g.result.reason == "千日手"


def test_game_kif_and_illegal_move():
    g = Game()
    g.push("7g7f")
    assert g.kif() == ["▲７六歩(77)"]
    assert g.kif_of(["3c3d", "8h2b+"]) == ["△３四歩(33)", "▲２二角成(88)"]
    with pytest.raises(ValueError):
        g.push("7f7e")  # 後手の番
