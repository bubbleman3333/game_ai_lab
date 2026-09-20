"""検証用の小さなポーカー（クーンポーカーと Leduc ホールデム）。

本物のノーリミット・ホールデムは大きすぎて「本当に均衡に近づいたか」を確かめられない。
そこで**答えが分かっている小さなポーカー**を用意し、ここで CFR の実装が
搾取されやすさ（exploitability）0 に近づくことを先に確かめる。

- クーンポーカー: カード 3 枚（J,Q,K）、1 ラウンド、ベット 1 回だけ。
  厳密な均衡が手計算で分かっていて、先手の期待値は **-1/18**。
- Leduc ホールデム: カード 6 枚（J,Q,K が 2 枚ずつ）、2 ラウンド、公開カード 1 枚、
  1 ラウンドにレイズ 2 回まで。不完全情報ゲームの研究でよく使われる標準的な題材。

どちらも `cfr.py` が扱える共通の形（`root` / `is_chance` / `actions` / `apply` …）で書く。
本物のホールデムは `deep_cfr.py` が同じ考え方をニューラルネットで近似する。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, replace

FOLD = "f"
CALL = "c"  # チェックもコールもこれ
RAISE = "r"


@dataclass(frozen=True)
class ToyConfig:
    """小さなポーカーの設定。"""

    name: str
    deck: tuple[int, ...]  # カードの値の集まり（同じ値が複数あってよい）
    rounds: int
    bet_size: tuple[int, ...]  # ラウンドごとのベット額
    max_raises: int  # 1 ラウンドあたりのレイズの上限
    ante: int
    public_per_round: tuple[int, ...]  # 各ラウンドの**ベットが始まる前に**めくる公開カードの枚数


KUHN = ToyConfig(
    name="kuhn",
    deck=(0, 1, 2),
    rounds=1,
    bet_size=(1,),
    max_raises=1,
    ante=1,
    public_per_round=(0,),
)

LEDUC = ToyConfig(
    name="leduc",
    deck=(0, 0, 1, 1, 2, 2),
    rounds=2,
    bet_size=(2, 4),
    max_raises=2,
    ante=1,
    public_per_round=(0, 1),
)

TOY_GAMES = {"kuhn": KUHN, "leduc": LEDUC}


@dataclass(frozen=True)
class ToyState:
    private: tuple[int, ...] = ()
    public: tuple[int, ...] = ()
    rnd: int = 0
    committed: tuple[int, int] = (0, 0)
    round_bet: tuple[int, int] = (0, 0)
    acted: tuple[bool, bool] = (False, False)
    raises: int = 0
    to_act: int = 0
    folded: int = -1
    finished: bool = False
    to_deal: int = 0  # 1 以上ならチャンスノード（カードをめくる番）
    hist: str = ""  # 行動の履歴。ラウンドの区切りは "/"


class ToyPoker:
    """小さなポーカーのゲーム木。`cfr.py` が期待する形をそろえている。"""

    def __init__(self, cfg: ToyConfig):
        self.cfg = cfg
        self.deck_counts = Counter(cfg.deck)

    # ---- 木の形 ----

    def root(self) -> ToyState:
        a = self.cfg.ante
        return ToyState(committed=(a, a), to_deal=2)

    def is_chance(self, s: ToyState) -> bool:
        return s.to_deal > 0

    def chance_outcomes(self, s: ToyState) -> list[tuple[ToyState, float]]:
        """カードを 1 枚めくる。同じ値はまとめて確率にする（木が小さくなる）。"""
        used = Counter(s.private) + Counter(s.public)
        remain = self.deck_counts - used
        total = sum(remain.values())
        out: list[tuple[ToyState, float]] = []
        for value in sorted(remain):
            prob = remain[value] / total
            if len(s.private) < 2:
                nxt = replace(s, private=s.private + (value,), to_deal=s.to_deal - 1)
            else:
                nxt = replace(s, public=s.public + (value,), to_deal=s.to_deal - 1)
            out.append((self._after_deal(nxt), prob))
        return out

    def _after_deal(self, s: ToyState) -> ToyState:
        """めくり終わったらベットを始める。"""
        if s.to_deal > 0:
            return s
        if len(s.private) < 2:
            return replace(s, to_deal=2 - len(s.private))
        return self._begin_round(s)

    def _begin_round(self, s: ToyState) -> ToyState:
        # このラウンドの前までに見えているべき公開カードの枚数に足りなければめくる
        need = sum(self.cfg.public_per_round[: s.rnd + 1]) - len(s.public)
        if need > 0:
            return replace(s, to_deal=need)
        return replace(s, round_bet=(0, 0), acted=(False, False), raises=0, to_act=0)

    def is_terminal(self, s: ToyState) -> bool:
        return s.finished

    def player(self, s: ToyState) -> int:
        return s.to_act

    def actions(self, s: ToyState) -> tuple[str, ...]:
        p, o = s.to_act, 1 - s.to_act
        acts = []
        if s.round_bet[o] > s.round_bet[p]:
            acts.append(FOLD)
        acts.append(CALL)
        if s.raises < self.cfg.max_raises:
            acts.append(RAISE)
        return tuple(acts)

    def infoset(self, s: ToyState) -> str:
        """手番のプレイヤーが見えているもの（自分のカード・公開カード・行動の履歴）。"""
        own = s.private[s.to_act]
        pub = "".join(str(c) for c in s.public)
        return f"{own}|{pub}|{s.hist}"

    def apply(self, s: ToyState, action: str) -> ToyState:
        p, o = s.to_act, 1 - s.to_act
        committed = list(s.committed)
        round_bet = list(s.round_bet)
        acted = [s.acted[0], s.acted[1]]
        raises = s.raises

        if action == FOLD:
            return replace(s, folded=p, finished=True, hist=s.hist + FOLD)
        if action == CALL:
            diff = round_bet[o] - round_bet[p]
            committed[p] += diff
            round_bet[p] += diff
            acted[p] = True
        elif action == RAISE:
            level = round_bet[o] + self.cfg.bet_size[s.rnd]
            committed[p] += level - round_bet[p]
            round_bet[p] = level
            acted[p] = True
            acted[o] = False
            raises += 1
        else:
            raise ValueError("知らない手: " + action)

        nxt = replace(
            s,
            committed=(committed[0], committed[1]),
            round_bet=(round_bet[0], round_bet[1]),
            acted=(acted[0], acted[1]),
            raises=raises,
            to_act=o,
            hist=s.hist + action,
        )
        if nxt.acted[0] and nxt.acted[1] and nxt.round_bet[0] == nxt.round_bet[1]:
            if nxt.rnd + 1 >= self.cfg.rounds:
                return replace(nxt, finished=True)
            return self._begin_round(replace(nxt, rnd=nxt.rnd + 1, hist=nxt.hist + "/"))
        return nxt

    # ---- 終局の値 ----

    def _strength(self, s: ToyState, p: int) -> tuple[int, int]:
        """公開カードと同じ値ならペア（強い）。次にカードの値。"""
        own = s.private[p]
        return (1 if own in s.public else 0, own)

    def terminal_value(self, s: ToyState) -> float:
        """プレイヤー 0 から見た収支。多く出した方の余りは戻る。"""
        stake = min(s.committed)
        if s.folded >= 0:
            return float(stake) if s.folded == 1 else float(-stake)
        a, b = self._strength(s, 0), self._strength(s, 1)
        if a == b:
            return 0.0
        return float(stake) if a > b else float(-stake)


def make(name: str) -> ToyPoker:
    if name not in TOY_GAMES:
        raise ValueError("知らないゲーム: " + name)
    return ToyPoker(TOY_GAMES[name])
