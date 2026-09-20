"""報酬のプリセット（連鎖を組む chain 型 / 対戦に勝つ versus 型）のテスト。"""

import pytest

from games.blob import ChainResult
from rl.blob.agent import reward_of
from rl.blob.config import REWARD_PRESETS, STYLE_DEFAULTS, TrainConfig
from rl.blob.evaluate import strength_score
from rl.blob.position import Candidate


def cand(chain: int = 0, sent: int = 0, cancelled: int = 0, all_clear: bool = False, dead: bool = False) -> Candidate:
    result = ChainResult(chain=chain, sent=sent, cancelled=cancelled, all_clear=all_clear)
    return Candidate(x=0, rot=0, path=["HD"], field_after=None, result=result,  # type: ignore[arg-type]
                     pending_after=0, carry_after=0, all_clear_bonus_after=False,
                     next_after=None, dead=dead)


CHAIN = REWARD_PRESETS["chain"]
VERSUS = REWARD_PRESETS["versus"]


def test_どちらのプリセットも死ぬ手は同じ罰():
    assert reward_of(cand(dead=True), CHAIN) == CHAIN.death
    assert reward_of(cand(dead=True), VERSUS) == VERSUS.death


def test_chain型は組みかけを壊す1連鎖を嫌がる():
    wait = reward_of(cand(), CHAIN)  # 何も消さずに積む手
    pop1 = reward_of(cand(chain=1, sent=0), CHAIN)
    assert pop1 < 0 < wait  # 1 連鎖で撃つより、積んで待つほうがよい


def test_versus型は1連鎖を罰しない():
    assert reward_of(cand(chain=1, sent=0), VERSUS) == pytest.approx(VERSUS.alive)


def test_chain型は連鎖が伸びるほど加速して得になる():
    rewards = [reward_of(cand(chain=n), CHAIN) for n in range(1, 11)]
    assert rewards == sorted(rewards)
    # 罰が外れる min_chain から上では、1 段あたりの伸び幅そのものが大きくなっていく
    # （連鎖数の 2 乗なので。これが「あと 1 段伸ばそう」という動機になる）
    above = rewards[CHAIN.min_chain - 1:]
    gaps = [b - a for a, b in zip(above, above[1:])]
    assert gaps == sorted(gaps)


def test_chain型はmin_chainの手前に段差がある():
    """min_chain に届くと罰が消えるので、そこを越える動機がとくに強くなる。"""
    just_below = reward_of(cand(chain=CHAIN.min_chain - 1), CHAIN)
    just_above = reward_of(cand(chain=CHAIN.min_chain), CHAIN)
    assert just_above - just_below > -CHAIN.small_chain


def test_小さく2回撃つより大きく1回撃つほうが得_chain型():
    twice = 2 * reward_of(cand(chain=3, sent=14), CHAIN)
    once = reward_of(cand(chain=6, sent=124), CHAIN)
    assert once > twice


def test_chain型はおじゃまの数をまったく見ない():
    """「連鎖オンリー」なので、送った数・相殺した数が変わっても報酬は同じ。"""
    plain = reward_of(cand(chain=6), CHAIN)
    assert reward_of(cand(chain=6, sent=124), CHAIN) == plain
    assert reward_of(cand(chain=6, cancelled=30), CHAIN) == plain


def test_versus型はおじゃまを送るほど得():
    assert reward_of(cand(chain=3, sent=14), VERSUS) > reward_of(cand(chain=3, sent=0), VERSUS)


def test_strength_scoreはスタイルで順位が変わる():
    def res(max_chain, fire_chain, big, small, sent):
        return {"solo": {"avg_max_chain": max_chain, "avg_fire_chain": fire_chain, "big_chains_per_game": big,
                         "small_fires_per_game": small, "survival_rate": 1.0, "avg_sent": sent}}

    builder = res(9.0, 6.5, 3.0, 0.5, 700)   # 大連鎖を我慢して組む
    rusher = res(5.0, 2.3, 0.5, 12.0, 1000)  # 小さく撃ち続けて、おじゃまは多く送る
    assert strength_score(builder, "chain") > strength_score(rusher, "chain")
    assert strength_score(rusher, "versus") > strength_score(builder, "versus")


def test_プリセットは設定から選べる():
    assert TrainConfig().reward_preset == "chain"
    assert set(REWARD_PRESETS) == set(STYLE_DEFAULTS) == {"chain", "versus"}


def test_連鎖オンリーはおじゃま無しで学習する():
    """組みかけが崩れると連鎖を組む練習にならないので、chain 型はおじゃまを降らせない。"""
    assert STYLE_DEFAULTS["chain"]["garbage_end"] == 0.0
    assert STYLE_DEFAULTS["versus"]["garbage_end"] > 0.0
