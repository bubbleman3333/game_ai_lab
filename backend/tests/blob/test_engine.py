"""ブロブチェインのルールエンジン（games/blob/）のテスト。

TypeScript 版との一致は shared/fixtures/blob/engine_cases.json 側で確かめる
（frontend/src/games/blob/engine/fixtures.test.ts）。ここは Python 版そのものの確認。
"""

import json
from pathlib import Path

import pytest

from games.blob import ALL_CLEAR_BONUS, BlobGame, Field, GARBAGE, H, Pair, SPAWN_X, SPAWN_Y, W, Rng
from games.blob.rules import simulate_chain

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "blob" / "engine_cases.json"


def field_of(rows_bottom_up: list[str]) -> Field:
    """下の行から文字列で盤面を作る（'.' 空き、'1'〜'4' 色、'G' おじゃま）。"""
    f = Field()
    for y, row in enumerate(rows_bottom_up):
        for x, ch in enumerate(row):
            f.set(x, y, 0 if ch == "." else GARBAGE if ch == "G" else int(ch))
    return f


def game_with(rows: list[str]) -> BlobGame:
    g = BlobGame(seed=1)
    g.field = field_of(rows)
    return g


def test_4つつながると消える():
    g = game_with(["1111.."])
    step = g.pop_step()
    assert step is not None
    assert (step.chain, len(step.cells), step.score) == (1, 4, 40)
    g.settle()
    assert g.field.is_empty()


def test_3つでは消えない():
    assert game_with(["111..."]).pop_step() is None


def test_13段目の粒は消えない():
    rows = ["." * W] * 12 + ["1111.."]
    assert game_with(rows).pop_step() is None


def test_2連鎖の得点():
    # 赤（1）4 つが消えると、上の青（2）が落ちて 5 つつながる
    g = game_with(["1112..", "212...", "22...."])
    assert g.pop_step().chain == 1
    g.settle()
    s2 = g.pop_step()
    assert s2.chain == 2
    assert s2.score == 10 * 5 * (8 + 2)  # 青 5 つ × (連鎖ボーナス 8 + 5 個つながりのボーナス 2)


def test_隣のおじゃまも消える():
    g = game_with(["1111G."])
    step = g.pop_step()
    assert len(step.cells) == 5
    assert GARBAGE in [c for _, c in step.cells]


def test_70点ごとに1個のおじゃまを送る():
    g = game_with(["1111.."])
    step = g.pop_step()
    assert step.score == 40 and step.attack == 0  # 40 点では届かない
    assert g.carry == 40


def test_予告と相殺してから相手に送る():
    g = game_with(["1112..", "212...", "22...."])
    g.receive_garbage(5)
    r = g.resolve()
    assert r.cancelled + r.sent == r.attack
    assert r.cancelled == min(5, r.attack)
    assert g.pending == 5 - r.cancelled


def test_全消しの次の連鎖にボーナス():
    g = game_with(["1111.."])
    g.resolve()
    assert g.all_clear_bonus and g.stats.all_clears == 1
    g.field = field_of(["2222.."])
    r = g.resolve()
    assert r.attack >= ALL_CLEAR_BONUS


def test_おじゃまは30個までしか降らない():
    g = BlobGame(seed=2)
    g.receive_garbage(40)
    assert len(g.drop_garbage()) == 30
    assert g.pending == 10
    assert len(g.drop_garbage()) == 10


def test_3列目の12段目がふさがると負け():
    g = BlobGame(seed=3)
    g.field.set(SPAWN_X, SPAWN_Y, 1)
    assert g.spawn() is False
    assert g.over


def test_ちぎりで別々の列に落ちる():
    # 横向きの組。左の列だけ高いと、子だけが下まで落ちる
    g = game_with(["1....."])
    g.current = Pair(0, 5, 1, 2, 3)  # 軸が列 0、子が列 1
    g.place(0, 1)
    assert g.field.get(0, 1) == 2  # 軸は積まれた粒の上
    assert g.field.get(1, 0) == 3  # 子は床まで落ちる


def test_path_toで届かない置き方はNone():
    g = BlobGame(seed=4)
    assert g.path_to(SPAWN_X, 0) == ["HD"]
    assert g.path_to(0, 0) == ["L", "L", "HD"]
    assert g.path_to(5, 1) is None  # rot=1 は子が右なので列 5 には置けない
    # 通り道を塞ぐと届かなくなる
    for y in range(H):
        g.field.set(4, y, GARBAGE)
    assert g.path_to(5, 0) is None


def test_placeできない場所はValueError():
    g = BlobGame(seed=5)
    for y in range(H):
        g.field.set(0, y, GARBAGE)
    with pytest.raises(ValueError):
        g.place(0, 0)


def test_simulate_chainはpop_stepと同じ連鎖数():
    rows = ["1112..", "212...", "22...."]
    g = game_with(rows)
    chain, popped, score = simulate_chain(field_of(rows))
    r = g.resolve()
    assert (chain, popped, score) == (r.chain, r.popped, r.score)


def test_乱数はfixtureと一致する():
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    r = Rng(data["rng"]["seed"])
    for want in data["rng"]["values"]:
        assert r.next() == pytest.approx(want, abs=1e-12)


def test_fixtureの対局を再生できる():
    """テストデータが古くなっていないか（作り直しを忘れていないか）の確認。"""
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    case = data["random_games"][0]
    g = BlobGame(seed=case["seed"])
    for i, turn in enumerate(case["turns"]):
        if turn["garbage"]:
            g.receive_garbage(turn["garbage"])
        for a in turn["actions"]:
            if a == "L":
                g.move(-1)
            elif a == "R":
                g.move(1)
            elif a == "CW":
                g.rotate(1)
            elif a == "CCW":
                g.rotate(-1)
            elif a == "HD":
                g.hard_drop()
        g.lock()
        r = g.resolve()
        g.drop_garbage()
        g.spawn()
        assert (r.chain, r.score, r.sent) == (turn["chain"], turn["score"], turn["sent"]), f"{i} 手目"
    assert g.score == case["final"]["score"]
