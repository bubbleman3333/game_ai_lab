"""本物のノーリミット・ホールデムを学習する本体（外部サンプリング MCCFR）。

`cfr.py` は木を全部たどる厳密版で、小さなポーカーにしか使えない。ここは同じ考え方を
**サンプリング**で回す版で、まとめた（抽象化した）ノーリミット・ホールデムを扱う。

1 回の走査（traversal）でやること:

1. カードを 1 組配る（＝チャンスを 1 通りだけ引く）。
2. **学習する側の手番では、打てる手を全部試す**。相手の手番では今の戦略から 1 つだけ引く。
3. 「全部試した結果」と「実際に選ぶ確率で混ぜた結果」の差を後悔（regret）としてためる。

学習する側だけ全部試すので「外部サンプリング」と呼ぶ。相手の側をサンプリングで済ませる
ぶん 1 回が軽く、そのかわり回数を稼ぐ。ためた後悔から作る平均戦略がナッシュ均衡に近づく。

情報集合の鍵は「スタックの深さ・ストリート・手札のバケツ・行動の履歴」。
**相手の手札は入らない**（見えないので）。ここが完全情報のゲームとの決定的な違い。

速さについて: 手の枠は 5 つしかないので、**numpy を使わず素の Python のリストで持つ**。
5 要素の配列だと numpy は呼び出しの手間の方が高くつき、実測で 3 倍以上遅かった。
保存するときだけ numpy にまとめる。
"""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np

from games.poker.cards import Rng
from games.poker.game import deal
from games.poker.rules import (
    IDX_RAISE_BASE, State, action_count, action_from_index, advance_history, apply_action,
    legal_mask, payoff,
)
from . import abstraction, config

N_ACTIONS = action_count(config.RAISE_FRACTIONS)
_STREET_CHARS = "pftr"
_FRACTIONS = config.RAISE_FRACTIONS
_MAX_RAISES = config.MAX_RAISES_PER_STREET


def infoset_key(depth: int, street: int, bucket: int, hist: str) -> str:
    """情報集合の名前。短い文字列にしておく（何十万個も持つので）。"""
    return f"{depth}{_STREET_CHARS[street]}{bucket}|{hist}"


def street_raises(hist: str) -> int:
    """今のストリートで何回レイズがあったか（履歴の最後の区切りより後ろを見る）。"""
    seg = hist.rsplit("/", 1)[-1]
    return sum(1 for ch in seg if ch.isdigit() and int(ch) >= IDX_RAISE_BASE)


def _uniform(mask: list[bool]) -> list[float]:
    n = sum(mask)
    p = 1.0 / n
    return [p if ok else 0.0 for ok in mask]


class Table:
    """情報集合ごとの後悔と平均戦略のもと。"""

    __slots__ = ("regret", "strategy_sum")

    def __init__(self) -> None:
        self.regret: dict[str, list[float]] = {}
        self.strategy_sum: dict[str, list[float]] = {}

    def policy(self, key: str, mask: list[bool]) -> list[float]:
        """後悔マッチング: 後悔の正の部分に比例した確率。打てない手は必ず 0。"""
        r = self.regret.get(key)
        if r is None:
            self.regret[key] = [0.0] * N_ACTIONS
            self.strategy_sum[key] = [0.0] * N_ACTIONS
            return _uniform(mask)
        total = 0.0
        out = [0.0] * N_ACTIONS
        for i in range(N_ACTIONS):
            if mask[i] and r[i] > 0.0:
                out[i] = r[i]
                total += r[i]
        if total <= 0.0:
            return _uniform(mask)
        for i in range(N_ACTIONS):
            out[i] /= total
        return out

    def average(self, key: str, mask: list[bool] | None = None) -> list[float]:
        """平均戦略。学習していない情報集合なら打てる手の等確率。"""
        s = self.strategy_sum.get(key)
        if s is None:
            return _uniform(mask) if mask else [1.0 / N_ACTIONS] * N_ACTIONS
        out = [s[i] if (mask is None or mask[i]) else 0.0 for i in range(N_ACTIONS)]
        total = sum(out)
        if total <= 0.0:
            return _uniform(mask) if mask else [1.0 / N_ACTIONS] * N_ACTIONS
        return [v / total for v in out]

    def __len__(self) -> int:
        return len(self.regret)


def _next_raises(st: State, child: State, index: int, raises: int) -> int:
    """次のノードでの「このストリートのレイズ回数」。ストリートが変わったら 0 に戻す。"""
    if child.street != st.street:
        return 0
    return raises + (1 if index >= IDX_RAISE_BASE else 0)


def _bucket_of(st: State, p: int, cache: dict) -> int:
    key = (p, st.street)
    got = cache.get(key)
    if got is None:
        got = abstraction.bucket(st.holes[p], st.board)
        cache[key] = got
    return got


def traverse(
    st: State,
    player: int,
    table: Table,
    depth: int,
    hist: str,
    raises: int,
    rng: random.Random,
    weight: float,
    cache: dict,
) -> float:
    """木をたどって `player` 視点の収支を返しつつ、`player` の後悔をためる。"""
    if st.finished:
        return float(payoff(st)[player])

    p = st.to_act
    mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, raises)
    key = infoset_key(depth, st.street, _bucket_of(st, p, cache), hist)
    sigma = table.policy(key, mask)

    if p == player:
        values = [0.0] * N_ACTIONS
        node_value = 0.0
        for i in range(N_ACTIONS):
            if not mask[i]:
                continue
            child = apply_action(st, action_from_index(st, i, _FRACTIONS))
            v = traverse(child, player, table, depth, advance_history(st, child, i, hist),
                         _next_raises(st, child, i, raises), rng, weight, cache)
            values[i] = v
            node_value += sigma[i] * v
        r = table.regret[key]
        for i in range(N_ACTIONS):
            if mask[i]:
                v = r[i] + values[i] - node_value
                r[i] = v if v > 0.0 else 0.0  # CFR+: 後悔は 0 で下げ止める
        return node_value

    # 相手の手番: 今の戦略から 1 つだけ引く。平均戦略はここでためる
    s = table.strategy_sum[key]
    for i in range(N_ACTIONS):
        if sigma[i]:
            s[i] += weight * sigma[i]
    roll = rng.random()
    acc = 0.0
    chosen = N_ACTIONS - 1
    for i in range(N_ACTIONS):
        acc += sigma[i]
        if roll < acc:
            chosen = i
            break
    while not mask[chosen]:  # 念のため（確率 0 の手を引いてしまったとき）
        chosen -= 1
    child = apply_action(st, action_from_index(st, chosen, _FRACTIONS))
    return traverse(child, player, table, depth, advance_history(st, child, chosen, hist),
                    _next_raises(st, child, chosen, raises), rng, weight, cache)


def run_iteration(table: Table, deck_rng: Rng, rng: random.Random, t: int, depth_index: int) -> None:
    """1 組配って、両者ぶん走査する。"""
    stack = config.STACK_DEPTHS_BB[depth_index] * 2  # ビッグブラインド = 2
    for player in (0, 1):
        st = deal(deck_rng, start_stack=stack, button=0)
        traverse(st, player, table, depth_index, "", 0, rng, float(t), {})


# ---- 保存と読み込み ----


def _average_rows(table: Table, keys: list[str]) -> np.ndarray:
    avg = np.empty((len(keys), N_ACTIONS), dtype=np.float32)
    uniform = [1.0 / N_ACTIONS] * N_ACTIONS
    for i, k in enumerate(keys):
        s = table.strategy_sum[k]
        total = sum(s)
        avg[i] = [v / total for v in s] if total > 0 else uniform
    return avg


def save(path: Path, table: Table, meta: dict, average_only: bool = False) -> None:
    """npz に保存する。`average_only` なら遊ぶのに必要な平均戦略だけ（小さい）。"""
    keys = sorted(table.regret)
    arrays: dict[str, np.ndarray] = {
        "keys": np.array(keys),
        "meta": np.array([json.dumps(meta, ensure_ascii=False)]),
        "average": _average_rows(table, keys),
    }
    if not average_only:
        arrays["regret"] = np.array([table.regret[k] for k in keys], dtype=np.float32)
        arrays["strategy_sum"] = np.array([table.strategy_sum[k] for k in keys], dtype=np.float64)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **arrays)


def load(path: Path) -> Table:
    """学習の続きをするために全部読む。"""
    table = Table()
    with np.load(path, allow_pickle=False) as z:
        keys = [str(k) for k in z["keys"]]
        if "regret" not in z.files:
            raise ValueError("平均戦略だけの保存からは学習を続けられない")
        regret = z["regret"]
        strategy_sum = z["strategy_sum"]
    for i, k in enumerate(keys):
        table.regret[k] = [float(v) for v in regret[i]]
        table.strategy_sum[k] = [float(v) for v in strategy_sum[i]]
    return table


class Strategy:
    """遊ぶとき用。平均戦略だけを持つ（軽い）。"""

    def __init__(self, table: dict[str, list[float]], meta: dict | None = None):
        self.table = table
        self.meta = meta or {}

    @classmethod
    def from_file(cls, path: Path) -> "Strategy":
        with np.load(path, allow_pickle=False) as z:
            keys = [str(k) for k in z["keys"]]
            avg = z["average"]
            meta = json.loads(str(z["meta"][0])) if "meta" in z.files else {}
        return cls({k: [float(v) for v in avg[i]] for i, k in enumerate(keys)}, meta)

    @classmethod
    def from_table(cls, table: Table, meta: dict | None = None) -> "Strategy":
        keys = sorted(table.regret)
        avg = _average_rows(table, keys)
        return cls({k: [float(v) for v in avg[i]] for i, k in enumerate(keys)}, meta)

    def probabilities(self, st: State, hist: str, depth: int) -> list[float]:
        """今の局面で各枠を選ぶ確率。学習していない場面は打てる手の等確率。"""
        mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, street_raises(hist))
        bucket = abstraction.bucket(st.holes[st.to_act], st.board)
        probs = self.table.get(infoset_key(depth, st.street, bucket, hist))
        if probs is None:
            return _uniform(mask)
        out = [probs[i] if mask[i] else 0.0 for i in range(N_ACTIONS)]
        total = sum(out)
        if total <= 0.0:
            return _uniform(mask)
        return [v / total for v in out]

    def __len__(self) -> int:
        return len(self.table)

