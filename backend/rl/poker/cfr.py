"""表形式の CFR+ と、搾取されやすさ（exploitability）の厳密な計算。

**なぜ Q 学習ではなく CFR なのか**

テトリスやオセロのように盤面が全部見えるゲームなら「この局面の価値」を学べばよい。
ポーカーは相手の手札が見えないので、決まった打ち方は必ず読まれる。**手を確率で混ぜる**必要があり、
自己対戦で価値を学ぶやり方（DQN や TD）はじゃんけんのように巡回して収束しない。

CFR は「あの場面でこの手を選んでいれば、どれだけ得だったか」という後悔（regret）をためて、
後悔の大きい手を選ぶ確率を上げていく。平均戦略はナッシュ均衡に近づく。
ヘッズアップのゼロサムなら、均衡に近い戦略は**どんな相手にも期待値で負けない**。

ここは木を全部たどる厳密版で、小さなポーカー（`toy.py`）専用。本物のホールデムは木が
大きすぎるので `deep_cfr.py` がニューラルネットで近似する。この厳密版は
「近似版の考え方が正しいか」を確かめるための基準になる。
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import numpy as np

Strategy = dict[str, np.ndarray]


class Tabular:
    """情報集合ごとの後悔と、平均戦略のための足し上げ。"""

    def __init__(self) -> None:
        self.regret: dict[str, np.ndarray] = {}
        self.strategy_sum: dict[str, np.ndarray] = {}

    def current(self, key: str, n: int) -> np.ndarray:
        """後悔マッチング: 後悔の正の部分に比例した確率。全部 0 なら等確率。"""
        r = self.regret.get(key)
        if r is None:
            r = np.zeros(n)
            self.regret[key] = r
            self.strategy_sum[key] = np.zeros(n)
        pos = np.maximum(r, 0.0)
        total = pos.sum()
        if total <= 0:
            return np.full(n, 1.0 / n)
        return pos / total

    def average(self) -> Strategy:
        out: Strategy = {}
        for key, s in self.strategy_sum.items():
            total = s.sum()
            out[key] = s / total if total > 0 else np.full(len(s), 1.0 / len(s))
        return out

    @property
    def infosets(self) -> int:
        return len(self.regret)


class _Pass:
    """1 回の走査のあいだ使う作業場所。

    **この反復のあいだ、同じ情報集合はずっと同じ戦略を使わなければならない**。
    走査の途中で後悔を書き換えると、同じ情報集合の別の局面が違う戦略で計算されてしまい、
    収束が桁違いに遅くなる（実装したときに実際そうなっていた）。そこで戦略は 1 反復ぶん
    覚えておき、後悔の増分は貯めて走査の最後にまとめて足す。
    """

    __slots__ = ("sigma", "delta", "reach_sum")

    def __init__(self) -> None:
        self.sigma: dict[str, np.ndarray] = {}
        self.delta: dict[str, np.ndarray] = {}
        self.reach_sum: dict[str, float] = {}


def _walk(game: Any, s: Any, reach: list[float], player: int, table: Tabular, work: _Pass) -> float:
    """木をたどって `player` 視点の期待値を返しつつ、`player` の後悔の増分を貯める。

    reach = [プレイヤー0 の到達確率, プレイヤー1 の到達確率, チャンスの確率]
    """
    if game.is_terminal(s):
        v = game.terminal_value(s)
        return v if player == 0 else -v

    if game.is_chance(s):
        total = 0.0
        for child, prob in game.chance_outcomes(s):
            nxt = [reach[0], reach[1], reach[2] * prob]
            total += prob * _walk(game, child, nxt, player, table, work)
        return total

    cur = game.player(s)
    acts = game.actions(s)
    key = game.infoset(s)
    sigma = work.sigma.get(key)
    if sigma is None:
        sigma = table.current(key, len(acts))
        work.sigma[key] = sigma

    values = np.empty(len(acts))
    for i, a in enumerate(acts):
        nxt = list(reach)
        nxt[cur] *= sigma[i]
        values[i] = _walk(game, game.apply(s, a), nxt, player, table, work)
    node_value = float(sigma @ values)

    if cur == player:
        # 相手とチャンスの到達確率（＝この情報集合に来る「相手のせい」の確率）で重み付ける
        cf = reach[1 - player] * reach[2]
        if cf > 0:
            d = work.delta.get(key)
            if d is None:
                d = work.delta[key] = np.zeros(len(acts))
            d += cf * (values - node_value)
        work.reach_sum[key] = work.reach_sum.get(key, 0.0) + reach[player]
    return node_value


def train(game: Any, iterations: int, on_step: Any = None, log_every: int = 0) -> Tabular:
    """CFR+ を回して平均戦略のもとを作る（1 回ごとに両者を交互に更新）。

    `on_step(t, table)` を渡すと `log_every` 回ごとに呼ぶ（学習の記録用）。
    """
    table = Tabular()
    for t in range(1, iterations + 1):
        for player in (0, 1):
            work = _Pass()
            _walk(game, game.root(), [1.0, 1.0, 1.0], player, table, work)
            for key, d in work.delta.items():
                r = table.regret[key]
                np.maximum(r + d, 0.0, out=r)  # CFR+: 後悔を 0 で下げ止める
            for key, reach in work.reach_sum.items():
                # 平均戦略は「あとの反復を重く」する（linear averaging）
                table.strategy_sum[key] += t * reach * work.sigma[key]
        if on_step is not None and log_every and t % log_every == 0:
            on_step(t, table)
    return table


# ---- 搾取されやすさ（どれだけ食い物にされるか）----


def _collect(game: Any, s: Any, depth: int, structure: dict, order: dict) -> None:
    if s in structure:
        return
    if game.is_terminal(s):
        structure[s] = ("terminal", ())
        order[depth].append(s)
        return
    if game.is_chance(s):
        kids = tuple((prob, child) for child, prob in game.chance_outcomes(s))
        structure[s] = ("chance", kids)
        order[depth].append(s)
        for _, child in kids:
            _collect(game, child, depth + 1, structure, order)
        return
    kids = tuple((a, game.apply(s, a)) for a in game.actions(s))
    structure[s] = ("player", kids)
    order[depth].append(s)
    for _, child in kids:
        _collect(game, child, depth + 1, structure, order)


def best_response_value(game: Any, strategy: Strategy, br_player: int) -> float:
    """`strategy` を打つ相手に対して、`br_player` が最善で応じたときの期待値。

    不完全情報なので「局面ごとに一番よい手」を選ぶのは反則（相手の手札を見たことになる）。
    **情報集合ごとに 1 つの手**を選ばなければならない。そこで、
    「相手とチャンスの到達確率」で重み付けた値を情報集合ごとに合計してから手を決める。
    同じ情報集合のノードは必ず同じ深さにあるので、深い方から順に決めていけばよい。
    """
    root = game.root()
    structure: dict[Any, tuple[str, tuple]] = {}
    order: dict[int, list] = defaultdict(list)
    _collect(game, root, 0, structure, order)

    # 相手とチャンスの到達確率（br_player 自身の選択は含めない）
    reach: dict[Any, float] = defaultdict(float)
    reach[root] = 1.0
    for depth in sorted(order):
        for s in order[depth]:
            kind, kids = structure[s]
            r = reach[s]
            if kind == "terminal" or r == 0.0:
                continue
            if kind == "chance":
                for prob, child in kids:
                    reach[child] += r * prob
                continue
            cur = game.player(s)
            if cur == br_player:
                for _, child in kids:
                    reach[child] += r  # 自分の選択は確率に入れない
            else:
                sigma = strategy.get(game.infoset(s))
                n = len(kids)
                if sigma is None:
                    sigma = np.full(n, 1.0 / n)
                for i, (_, child) in enumerate(kids):
                    reach[child] += r * float(sigma[i])

    values: dict[Any, float] = {}
    for depth in sorted(order, reverse=True):
        # この深さの br_player のノードは、情報集合ごとにまとめて手を決める
        groups: dict[str, list] = defaultdict(list)
        for s in order[depth]:
            kind, kids = structure[s]
            if kind == "terminal":
                v = game.terminal_value(s)
                values[s] = v if br_player == 0 else -v
            elif kind == "chance":
                values[s] = sum(prob * values[child] for prob, child in kids)
            elif game.player(s) == br_player:
                groups[game.infoset(s)].append(s)
            else:
                sigma = strategy.get(game.infoset(s))
                n = len(kids)
                if sigma is None:
                    sigma = np.full(n, 1.0 / n)
                values[s] = sum(float(sigma[i]) * values[child] for i, (_, child) in enumerate(kids))
        for nodes in groups.values():
            n = len(structure[nodes[0]][1])
            cfv = np.zeros(n)
            for s in nodes:
                r = reach[s]
                if r == 0.0:
                    continue
                for i, (_, child) in enumerate(structure[s][1]):
                    cfv[i] += r * values[child]
            best = int(np.argmax(cfv))
            for s in nodes:
                values[s] = values[structure[s][1][best][1]]
    return values[root]


def exploitability(game: Any, strategy: Strategy) -> float:
    """搾取されやすさ（1 局あたりのチップ）。0 に近いほど「カモにされない」。

    2 人ゼロサムでは、両者がそれぞれ最善で応じたときの期待値の平均になる。
    均衡なら 0、隙があるほど大きい。
    """
    br0 = best_response_value(game, strategy, 0)
    br1 = best_response_value(game, strategy, 1)
    return (br0 + br1) / 2.0


def game_value(game: Any, strategy: Strategy) -> float:
    """その戦略どうしで打ったときのプレイヤー 0 の期待値。"""
    root = game.root()
    structure: dict[Any, tuple[str, tuple]] = {}
    order: dict[int, list] = defaultdict(list)
    _collect(game, root, 0, structure, order)
    values: dict[Any, float] = {}
    for depth in sorted(order, reverse=True):
        for s in order[depth]:
            kind, kids = structure[s]
            if kind == "terminal":
                values[s] = game.terminal_value(s)
            elif kind == "chance":
                values[s] = sum(prob * values[child] for prob, child in kids)
            else:
                sigma = strategy.get(game.infoset(s))
                n = len(kids)
                if sigma is None:
                    sigma = np.full(n, 1.0 / n)
                values[s] = sum(float(sigma[i]) * values[child] for i, (_, child) in enumerate(kids))
    return values[root]
