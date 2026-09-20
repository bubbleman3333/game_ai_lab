"""強さの測り方。

ポーカーは運の幅が大きく、素朴に対戦させると「1 万局やっても、どちらが強いか分からない」
ことがざらにある。そこで**同じカードを配って席を入れ替えて 2 回打つ**（ミラー方式）。
カードの運が打ち消し合うので、同じ局数でずっと細かく差が見える。

単位は **mbb/hand**（1 局あたり、ビッグブラインドの 1/1000 が何個か）。ポーカーの世界で
よく使われる単位で、+50 mbb/hand ならかなり勝っている。

それでもブレは残るので、**標準誤差（`stderr_mbb`）も一緒に返す**。実際、同じ戦略が
4000 局の評価で +392、24000 局で -165 になったことがあり、局数をケチると
「一番よい重み」の選択がほぼ運になる。差が標準誤差の 2 倍より小さければ、まだ何も言えない。

「簡単に退場しないか」は別に測る（`survival`）。スタックを持ち越して片方が飛ぶまで打ち、
自分が飛んだ割合と、何局もったかを見る。
"""

from __future__ import annotations

from dataclasses import dataclass

from games.poker.cards import Rng
from games.poker.game import PolicyFn, deal, play_hand, play_match
from games.poker.rules import BIG_BLIND
from . import config


@dataclass
class HeadToHead:
    """1 対 1 の結果（すべて「a から見て」）。"""

    hands: int
    chips: int
    mbb_per_hand: float
    win_rate: float  # 引き分けを 0.5 として数えた勝率
    stderr_mbb: float = 0.0  # mbb/hand の標準誤差

    def as_dict(self) -> dict:
        return {
            "hands": self.hands,
            "chips": self.chips,
            "mbb_per_hand": round(self.mbb_per_hand, 1),
            "stderr_mbb": round(self.stderr_mbb, 1),
            "win_rate": round(self.win_rate, 4),
        }

    def __str__(self) -> str:
        return f"{self.mbb_per_hand:+.1f} ± {self.stderr_mbb:.1f} mbb/hand（{self.hands:,} 局）"


def head_to_head(
    a: PolicyFn,
    b: PolicyFn,
    hands: int = 20_000,
    seed: int = 1,
    start_stack: int = 200,
) -> HeadToHead:
    """同じカードで席を入れ替えて 2 回ずつ打つ（ミラー方式）。`hands` は合計の局数。"""
    rng = Rng(seed)
    pairs = max(1, hands // 2)
    chips = 0
    wins = 0.0
    played = 0
    # 「同じカードで 2 回打った合計」を 1 つの標本として散らばりを測る（ここがブレの単位）
    pair_sum = 0.0
    pair_sq = 0.0
    for i in range(pairs):
        state = deal(rng, start_stack=start_stack, button=i % 2)
        gain_pair = 0
        for seat in (0, 1):
            policies = (a, b) if seat == 0 else (b, a)
            result = play_hand(state, policies, config.RAISE_FRACTIONS,
                               config.MAX_RAISES_PER_STREET)
            gain = result.payoff[seat]
            gain_pair += gain
            chips += gain
            wins += 1.0 if gain > 0 else (0.5 if gain == 0 else 0.0)
            played += 1
        pair_sum += gain_pair
        pair_sq += gain_pair * gain_pair
    mean_pair = pair_sum / pairs
    var_pair = max(0.0, pair_sq / pairs - mean_pair * mean_pair)
    # 1 局あたりに直すので 2 で割り、標本数の平方根で割る
    stderr = (var_pair / pairs) ** 0.5 / 2 / BIG_BLIND * 1000 if pairs > 1 else 0.0
    return HeadToHead(
        hands=played,
        chips=chips,
        mbb_per_hand=chips / played / BIG_BLIND * 1000,
        win_rate=wins / played,
        stderr_mbb=stderr,
    )


@dataclass
class Survival:
    """退場のしにくさ（すべて「a から見て」）。"""

    matches: int
    busted: int  # a が飛んだ回数
    survived: int  # 上限の局数まで生き残った回数
    avg_hands: float

    @property
    def bust_rate(self) -> float:
        return self.busted / self.matches

    def as_dict(self) -> dict:
        return {
            "matches": self.matches,
            "busted": self.busted,
            "survived": self.survived,
            "bust_rate": round(self.bust_rate, 4),
            "avg_hands": round(self.avg_hands, 1),
        }


def survival(
    a: PolicyFn,
    b: PolicyFn,
    matches: int = 200,
    start_stack: int = 200,
    max_hands: int = 500,
    seed: int = 1,
) -> Survival:
    """スタックを持ち越して、片方が飛ぶまで打つのを何度も繰り返す。

    席も入れ替える（先にボタンを持つ方が少し有利なため）。
    """
    busted = 0
    survived = 0
    total_hands = 0
    for i in range(matches):
        seat = i % 2
        policies = (a, b) if seat == 0 else (b, a)
        result = play_match(policies, seed=seed * 1000 + i, start_stack=start_stack,
                            max_hands=max_hands, fractions=config.RAISE_FRACTIONS,
                            max_raises=config.MAX_RAISES_PER_STREET)
        total_hands += result.hands
        if result.busted == seat:
            busted += 1
        elif result.busted < 0:
            survived += 1
    return Survival(matches, busted, survived, total_hands / matches)


def against_baselines(
    policy: PolicyFn,
    baselines: dict[str, PolicyFn],
    hands: int = 20_000,
    seed: int = 1,
    start_stack: int = 200,
) -> dict[str, dict]:
    """基準の相手ひとりひとりと対戦して結果を並べる。"""
    out: dict[str, dict] = {}
    for name, opponent in baselines.items():
        out[name] = head_to_head(policy, opponent, hands=hands, seed=seed,
                                 start_stack=start_stack).as_dict()
    return out


def score_of(results: dict[str, dict]) -> float:
    """「一番よい学習結果」を選ぶための 1 つの数字。全部の相手に対する mbb/hand の平均。"""
    if not results:
        return 0.0
    return sum(r["mbb_per_hand"] for r in results.values()) / len(results)
