"""ブロブチェイン AI（rl/blob/）のテスト。学習そのものではなく、手の列挙・特徴量・選び方を確かめる。"""

import numpy as np

from games.blob import BlobGame, Field, GARBAGE, W
from rl.blob.agent import HeuristicAgent
from rl.blob.encoding import FEATURE_DIM, FEATURE_NAMES, chain_potential, encode_many
from rl.blob.env import BlobEnv
from rl.blob.position import Position, enumerate_candidates, position_after


def field_of(rows: list[str]) -> Field:
    f = Field()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            f.set(x, y, 0 if ch == "." else GARBAGE if ch == "G" else int(ch))
    return f


def test_特徴量の名前と次元が合っている():
    assert len(FEATURE_NAMES) == FEATURE_DIM


def test_候補は届く置き方だけを重複なく返す():
    pos = Position(field=Field(), current=(1, 2), next=[(3, 4)])
    cands = enumerate_candidates(pos)
    # 空の盤なら 4 向き × 6 列のうち、rot=1 は列 5、rot=3 は列 0 に置けない → 22 通り
    assert len(cands) == 22
    assert all(c.path[-1] == "HD" for c in cands)
    # 同じ色の組は「子が上」と「子が下」が同じ結果になるので 1 つにまとまる
    same = enumerate_candidates(Position(field=Field(), current=(1, 1)))
    assert len(same) == 11


def test_連鎖する手が候補に現れる():
    pos = Position(field=field_of(["111...", "2....."]), current=(1, 2))
    cands = enumerate_candidates(pos)
    best = max(cands, key=lambda c: c.result.chain)
    assert best.result.chain >= 1
    assert best.result.score > 0


def stack(rows: int, empty_col: int | None = None) -> list[str]:
    """消えない（どの隣も色が違う）積み方を rows 段ぶん作る。empty_col の列だけ空ける。"""
    return [
        "".join("." if x == empty_col else str((x + y) % 4 + 1) for x in range(W))
        for y in range(rows)
    ]


def test_積みすぎた候補は死亡扱いになる():
    # ほかは 11 段、3 列目（x=2）だけ 10 段。3 列目に組を縦に置くと 12 段目がふさがって負け
    field = field_of(stack(11, empty_col=2))
    for y in range(10):
        field.set(2, y, (2 + y) % 4 + 1)
    cands = enumerate_candidates(Position(field=field, current=(1, 2)))
    assert any(c.dead for c in cands)
    assert all(c.x == 2 and c.rot in (0, 2) for c in cands if c.dead)


def test_出る場所がふさがっていたら候補なし():
    assert enumerate_candidates(Position(field=field_of(stack(12)), current=(1, 2))) == []


def test_chain_potentialはあと1個で消える形を見つける():
    # 赤 3 つ。列 3 に赤を落とせば 4 つつながる
    assert chain_potential(field_of(["111..."]))[0] == 1
    assert chain_potential(field_of(["11...."]))[0] == 0


def test_encodeは0付近に収まる():
    pos = Position(field=field_of(["112233", "1122.."]), current=(1, 2), next=[(3, 4)], pending=6)
    feats = encode_many(enumerate_candidates(pos))
    assert feats.shape[1] == FEATURE_DIM
    assert np.isfinite(feats).all()
    assert np.abs(feats).max() < 5


def test_position_afterで次の局面に進める():
    pos = Position(field=Field(), current=(1, 2), next=[(3, 4), (2, 2)])
    c = enumerate_candidates(pos)[0]
    nxt = position_after(c)
    assert nxt is not None
    assert nxt.current == (3, 4) and nxt.next == [(2, 2)]
    # NEXT が分からないところまで来たら None
    last = position_after(enumerate_candidates(nxt)[0])
    assert last is not None and last.current == (2, 2) and last.next == []
    assert position_after(enumerate_candidates(last)[0]) is None


def test_ヒューリスティックAIは連鎖を組みながら生き残る():
    env = BlobEnv(max_pairs=80, garbage_rate=0.0, seed=42)
    agent = HeuristicAgent()
    while not env.done:
        c = agent.choose(env.position())
        assert c is not None
        env.step(c)
    assert not env.game.over  # 80 手くらいでは死なない
    assert env.game.max_chain >= 3  # 連鎖を組めている
    assert env.game.stats.sent > 0


def test_ヒューリスティックAIは死ぬ手を選ばない():
    # 3 列目（x=2）以外が高く積まれていて、そこに置くと詰む盤面
    g = BlobGame(seed=7)
    g.field = field_of(stack(11, empty_col=2))
    for y in range(10):
        g.field.set(2, y, (2 + y) % 4 + 1)  # 3 列目も 10 段まで積む
    c = HeuristicAgent().choose(Position.from_game(g))
    assert c is not None and not c.dead
    assert c.x != 2 or c.rot != 0
