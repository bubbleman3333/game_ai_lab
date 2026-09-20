"""Deep CFR: 後悔をニューラルネットで覚える CFR。

`mccfr.py`（表形式）との違いは、**後悔をしまう先が表からニューラルネットに変わった**だけで、
木のたどり方（外部サンプリング）は同じ。表をやめたことで次の 2 つが効く。

1. **まとめ（抽象化）による取りこぼしが無くなる**。表のときは手を 32 通りのバケツに
   押し込んでいたので、同じバケツの中の差（「トップペア」と「ナッツ」など）が見えず、
   深いスタックの大きなポットで事故を起こしていた。
2. **スタックの深さをまたいで学習が共有される**。表のときは深さごとに別の表だったので、
   100BB の表は 100BB の対局からしか学べなかった。ネットなら深さはただの入力 1 つなので、
   浅いところで覚えたことが深いところにも効く。

流れ（1 反復ぶん）:

1. 両者それぞれについて、たくさんの対局をたどる。**学習する側の手番では打てる手を全部試し**、
   「全部試した結果」と「実際に選ぶ確率で混ぜた結果」の差を後悔として貯める。
2. 貯めた後悔を目標にして advantage ネットを**毎回まっさらから**学習し直す（Deep CFR の作法。
   古い予想に引きずられないようにするため）。
3. 相手の手番で使った打ち方は strategy メモリに貯める。最後にそれを覚えさせたネットが
   **平均戦略**＝実際に遊ぶ AI になる。

速さのために、木をたどるときは numpy 版のネット（`model.NumpyNet`）を使い、
学習だけ PyTorch（GPU）で行う。木をたどる部分は複数プロセスに分ける。
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

import numpy as np

from games.poker.cards import Rng
from games.poker.game import deal
from games.poker.rules import (
    BIG_BLIND, IDX_RAISE_BASE, State, action_count, action_from_index, advance_history,
    apply_action, legal_mask, payoff,
)
from . import config
from .encoding import N_FEATURES, features
from .model import NumpyNet, regret_match

N_ACTIONS = action_count(config.RAISE_FRACTIONS)
_FRACTIONS = config.RAISE_FRACTIONS
_MAX_RAISES = config.MAX_RAISES_PER_STREET


@dataclass
class DeepConfig:
    """Deep CFR の設定。"""

    hidden: int = 256
    layers: int = 3
    iterations: int = 200
    traversals_per_iter: int = 6_000  # 1 反復・1 人あたりにたどる対局数
    adv_memory: int = 400_000
    strategy_memory: int = 1_000_000
    adv_steps: int = 2_000  # advantage ネットの学習回数（毎回まっさらから）
    adv_batch: int = 4_096
    adv_lr: float = 1e-3
    strategy_steps: int = 8_000
    strategy_batch: int = 4_096
    strategy_lr: float = 1e-3
    # スタックの深さは対局ごとに変える（1 つのネットで全部の深さを扱う）
    min_stack_bb: float = 10.0
    max_stack_bb: float = 200.0


def sample_stack(rng: random.Random, cfg: DeepConfig) -> int:
    """対局ごとのスタック。浅いところも深いところも均等に経験させたいので、対数で一様に選ぶ。"""
    lo, hi = np.log(cfg.min_stack_bb), np.log(cfg.max_stack_bb)
    bb = float(np.exp(rng.uniform(lo, hi)))
    return max(BIG_BLIND * 2, int(round(bb * BIG_BLIND)))


class Reservoir:
    """貯水池サンプリング。決めた数を超えたら、古いものと**一様に入れ替える**。

    後ろの反復ばかり残ると偏るので、全部の反復から均等に残るこのやり方を使う
    （Deep CFR の論文どおり）。特徴量は float16 で持つ（0/1 と小さな小数ばかりなので
    精度は足りるし、置き場所が半分で済む）。
    """

    def __init__(self, capacity: int, n_features: int, n_actions: int, seed: int = 0):
        self.capacity = capacity
        self.x = np.zeros((capacity, n_features), dtype=np.float16)
        self.y = np.zeros((capacity, n_actions), dtype=np.float32)
        self.mask = np.zeros((capacity, n_actions), dtype=bool)
        self.w = np.zeros(capacity, dtype=np.float32)
        self.size = 0
        self.seen = 0
        self.rng = np.random.default_rng(seed)

    def add(self, x: np.ndarray, y: np.ndarray, mask: np.ndarray, w: np.ndarray) -> None:
        """まとめて入れる。

        1 件ずつ Python のループで入れると、1 反復あたり 100 万件で数秒かかっていた。
        「i 件目（通しで seen+i 件目）を確率 容量/(seen+i+1) で残す」という決まりは
        そのままに、乱数の生成と代入をまとめて行う。同じ場所に 2 件当たったら後の方が残るが、
        それも一様なので偏らない。
        """
        m = len(x)
        if m == 0:
            return
        start = 0
        free = self.capacity - self.size
        if free > 0:  # まだ空きがあるぶんはそのまま詰める
            take = min(free, m)
            sl = slice(self.size, self.size + take)
            self.x[sl] = x[:take]
            self.y[sl] = y[:take]
            self.mask[sl] = mask[:take]
            self.w[sl] = w[:take]
            self.size += take
            self.seen += take
            start = take
        if start >= m:
            return
        rest = m - start
        # 通しの番号（1 始まり）。これで割ることで「どの反復のものも均等に残る」
        counts = self.seen + np.arange(1, rest + 1, dtype=np.int64)
        slots = self.rng.integers(0, counts)
        keep = slots < self.capacity
        self.seen += rest
        if not keep.any():
            return
        idx = slots[keep]
        src = np.nonzero(keep)[0] + start
        self.x[idx] = x[src]
        self.y[idx] = y[src]
        self.mask[idx] = mask[src]
        self.w[idx] = w[src]

    def sample(self, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        idx = self.rng.integers(0, self.size, size=min(n, self.size))
        return self.x[idx], self.y[idx], self.mask[idx], self.w[idx]

    def __len__(self) -> int:
        return self.size


@dataclass
class Samples:
    """1 回の収集で集まったもの。プロセス間で受け渡しする。"""

    adv_x: list = field(default_factory=list)
    adv_y: list = field(default_factory=list)
    adv_mask: list = field(default_factory=list)
    adv_w: list = field(default_factory=list)
    str_x: list = field(default_factory=list)
    str_y: list = field(default_factory=list)
    str_mask: list = field(default_factory=list)
    str_w: list = field(default_factory=list)

    def arrays(self) -> dict:
        def pack(xs, dtype):
            return np.array(xs, dtype=dtype) if xs else np.zeros((0, 0), dtype=dtype)

        return {
            "adv_x": pack(self.adv_x, np.float16),
            "adv_y": pack(self.adv_y, np.float32),
            "adv_mask": pack(self.adv_mask, bool),
            "adv_w": np.array(self.adv_w, dtype=np.float32),
            "str_x": pack(self.str_x, np.float16),
            "str_y": pack(self.str_y, np.float32),
            "str_mask": pack(self.str_mask, bool),
            "str_w": np.array(self.str_w, dtype=np.float32),
        }


def _strategy_at(net: NumpyNet, st: State, player: int, hist: str, mask: list[bool],
                 cache: dict) -> tuple[np.ndarray, list[float]]:
    x = features(st, player, hist, cache)
    adv = net(x) if net.weights else np.zeros(len(mask), dtype=np.float32)
    return x, regret_match(adv, mask)


def traverse(
    st: State,
    player: int,
    hist: str,
    raises: int,
    nets: tuple[NumpyNet, NumpyNet],
    rng: random.Random,
    weight: float,
    out: Samples,
    cache: dict,
) -> float:
    """木をたどって `player` 視点の収支を返しつつ、学習のもとを貯める。

    `cache` はこの対局の間だけ使う、カード由来の特徴量の置き場所。
    """
    if st.finished:
        return float(payoff(st)[player])

    p = st.to_act
    mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, raises)
    x, sigma = _strategy_at(nets[p], st, p, hist, mask, cache)

    if p == player:
        values = [0.0] * len(mask)
        node_value = 0.0
        for i, ok in enumerate(mask):
            if not ok:
                continue
            child = apply_action(st, action_from_index(st, i, _FRACTIONS))
            nxt_raises = 0 if child.street != st.street else raises + (1 if i >= IDX_RAISE_BASE else 0)
            v = traverse(child, player, advance_history(st, child, i, hist), nxt_raises,
                         nets, rng, weight, out, cache)
            values[i] = v
            node_value += sigma[i] * v
        # 後悔は**開始スタックで割って**しまう。チップのままだと、深いスタックの局だけ
        # 桁が 20 倍大きくなり、ネットがそこばかりに引っぱられる。手の選び方は
        # 後悔の「比」だけで決まるので、割っても戦略は変わらない
        scale = 1.0 / max(1, st.start_stack)
        out.adv_x.append(x)
        out.adv_y.append([(values[i] - node_value) * scale if mask[i] else 0.0
                          for i in range(len(mask))])
        out.adv_mask.append(mask)
        out.adv_w.append(weight)
        return node_value

    # 相手の手番: 打ち方を覚えさせる材料にして、1 つだけ引く
    out.str_x.append(x)
    out.str_y.append(sigma)
    out.str_mask.append(mask)
    out.str_w.append(weight)

    roll = rng.random()
    acc = 0.0
    chosen = -1
    for i, prob in enumerate(sigma):
        acc += prob
        if roll < acc and mask[i]:
            chosen = i
            break
    if chosen < 0:
        chosen = max(range(len(sigma)), key=lambda i: sigma[i] if mask[i] else -1.0)
    child = apply_action(st, action_from_index(st, chosen, _FRACTIONS))
    nxt_raises = 0 if child.street != st.street else raises + (1 if chosen >= IDX_RAISE_BASE else 0)
    return traverse(child, player, advance_history(st, child, chosen, hist), nxt_raises,
                    nets, rng, weight, out, cache)


def collect(
    nets: tuple[NumpyNet, NumpyNet],
    player: int,
    traversals: int,
    seed: int,
    weight: float,
    cfg: DeepConfig,
) -> dict:
    """`traversals` 回ぶんたどって、学習のもとをまとめて返す。"""
    rng = random.Random(seed)
    deck = Rng(seed ^ 0x5F3759DF)
    out = Samples()
    for _ in range(traversals):
        stack = sample_stack(rng, cfg)
        st = deal(deck, start_stack=stack, button=rng.randint(0, 1))
        traverse(st, player, "", 0, nets, rng, weight, out, {})
    return out.arrays()
