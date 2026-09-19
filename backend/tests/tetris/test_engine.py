"""ルールエンジンのテスト。仕様は docs/RULES.md。"""

import json
from pathlib import Path

import pytest

from games.tetris import Board, Game, find_placements
from games.tetris.rules import SPIN_FULL, SPIN_MINI, compute_attack

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "tetris" / "engine_cases.json"


def test_bag_contains_each_piece_once():
    g = Game(seed=0)
    first_bag = ([g.current.type] + g.queue)[:7]
    assert sorted(first_bag) == sorted("IJLOSTZ")


def test_same_seed_same_sequence():
    assert Game(seed=10).queue == Game(seed=10).queue


def test_hard_drop_on_empty_board_lands_on_floor():
    g = Game(seed=0)
    piece = g.current.type
    g.hard_drop()
    assert g.stats.pieces == 1
    assert any(g.board.rows[0] >> x & 1 for x in range(10)), piece


def test_no_lock_out_when_piece_sticks_out_above_visible_area():
    # 左 2 列だけ見える範囲の一番上（y=19）まで積む。その上に置いても、次のミノが出せる限り続く（jstris と同じ）
    g = Game(seed=0)
    for y in range(20):
        g.board.rows[y] = 0b11
    g.force_current("O")
    for _ in range(4):
        g.move(-1)
    result = g.hard_drop()
    assert not result.game_over
    assert g.board.rows[20] & 0b11  # 見える範囲の上（y=20）にはみ出して置けている


def test_block_out_when_spawn_area_is_filled():
    # 真ん中（x=3〜5）を一番上まで積み、その上に O を置くと出現位置（x=4, y=20）がふさがる
    g = Game(seed=0)
    for y in range(20):
        g.board.rows[y] = 0b0000111000
    g.force_current("O")
    result = g.hard_drop()
    assert result.game_over


def test_line_clear_double_perfect_clear():
    g = Game(seed=0)
    g.board.rows[0] = 0x3FF & ~0b1111  # 左 4 列が空き
    g.board.rows[1] = 0x3FF & ~0b1111
    g.force_current("O")
    for _ in range(4):
        g.move(-1)
    g.hard_drop()
    g.force_current("O")
    for _ in range(2):
        g.move(-1)
    result = g.hard_drop()
    assert result.lines == 2
    assert result.perfect_clear
    assert result.attack == 1 + 10  # double(1) + パーフェクトクリア(10)
    assert g.board.is_empty()


def test_tspin_double_from_fixture_setup():
    case = json.loads(FIXTURES.read_text(encoding="utf-8"))["tspin_double"]
    g = Game(seed=1)
    g.board.rows[: len(case["setup_rows"])] = case["setup_rows"]
    g.force_current("T")
    for a in case["actions"][:-1]:
        g.apply(a)
    result = g.hard_drop()
    assert result.spin == SPIN_FULL
    assert result.lines == 2
    assert result.attack == 4


def test_movegen_finds_tspin_double():
    b = Board()
    b.rows[0] = 0x3FF & ~(1 << 4)
    b.rows[1] = 0x3FF & ~((1 << 3) | (1 << 4) | (1 << 5))
    b.rows[2] = 1 << 3
    spins = [p for p in find_placements(b, "T") if p.spin == SPIN_FULL]
    assert any(p.x == 4 and p.y == 1 and p.rot == 2 for p in spins)


def test_movegen_path_reproduces_placement():
    g = Game(seed=3)
    for p in find_placements(g.board, g.current.type)[:10]:
        g2 = Game(seed=3)
        for a in p.path:
            g2.apply(a)
        assert (g2.current.x, g2.current.y, g2.current.rot) == (p.x, p.y, p.rot)


@pytest.mark.parametrize(
    ("lines", "spin", "combo", "b2b", "expected"),
    [
        (4, "none", -1, False, 4),
        (4, "none", -1, True, 5),  # B2B テトリス
        (2, SPIN_FULL, -1, True, 5),  # B2B TSD
        (1, SPIN_MINI, -1, False, 0),
        (1, "none", 3, False, 1),  # 5 REN 目（combo 4）の single
    ],
)
def test_attack_table(lines, spin, combo, b2b, expected):
    assert compute_attack(lines, spin, combo, b2b, False).attack == expected


def test_garbage_cancel_and_rise():
    g = Game(seed=0)
    g.receive_garbage(3)
    assert g.pending[0][0] == 3
    g.hard_drop()  # 消さずに置く → 3 段せり上がる
    assert g.pending == []
    assert sum(1 for r in g.board.rows[:3] if bin(r).count("1") >= 9) == 3


def test_fixture_games_replay_identically():
    """保存済みテストデータと今のエンジンの結果が一致するか（TS 版も同じデータで確認する）。"""
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    for case in data["random_games"]:
        g = Game(seed=case["seed"])
        garbage = {int(k): v for k, v in case["garbage"].items()}
        locks = []
        for i, a in enumerate(case["actions"]):
            if i in garbage:
                g.receive_garbage(garbage[i])
            r = g.apply(a)
            if a == "HD":
                locks.append(r.to_dict())
        assert locks == case["locks"]
        assert g.snapshot() == case["final"]
