"""ソルバーの重い部分を numba で回す（`solver.py` から使う）。

`solver.py` の木は Python のオブジェクトで、1 ノードごとに numpy を呼ぶ。ノードが 60 個くらいの
「1 ストリートぶん」ならそれで十分速いが、**ターンでリバーの賭けまで組む**と、リバーのカード
48 通り × 木 13 本 × 26 ノードになり、Python の呼び出しの手間だけで 1 反復に 1 秒かかった。

ここでは 1 本の木（チャンスノードを含まない、1 ストリートぶんの賭けの木）を配列に平らにして
（`FlatTree`）、K 枚のボードぶんをまとめて numba のループで走査する（`walk_subtree`）。
ボードどうしは独立なので、ボードごとに別スレッドで回す（`prange`）。

ショーダウンは `RunoutLeaf` で持つ。ボード k ごとに R 枚のランアウト（リバーまでのカード）の
ショーダウンを、強さ順の累積和で厳密に計算して平均する（`solver.SortedShowdown` と同じ式）。
リバーのボードなら R = 1（そのもの）、ターンのボードなら R = 46（リバー全部）になる。

数はすべて float32 / int32。1326 通りのコンボをそのまま使う（ボードとかぶるコンボは重み 0）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numba
import numpy as np
from numba import njit, prange

from games.poker.rules import (
    IDX_RAISE_BASE, State, action_from_index, apply_action, legal_mask,
)
from . import config
from .fasteval import hand_values

N_COMBOS = 1326
A_MAX = 5
T_DECISION, T_FOLD, T_SHOWDOWN = 0, 1, 2

_c1, _c2 = np.triu_indices(52, 1)
COMBO_A = _c1.astype(np.int32)
COMBO_B = _c2.astype(np.int32)
_card_matrix = np.zeros((N_COMBOS, 52), dtype=bool)
_card_matrix[np.arange(N_COMBOS), _c1] = True
_card_matrix[np.arange(N_COMBOS), _c2] = True
CARD_COMBOS = np.stack([np.nonzero(_card_matrix[:, c])[0] for c in range(52)]).astype(np.int32)
_pos_in_card = np.zeros((52, N_COMBOS), dtype=np.int32)
for _c in range(52):
    _pos_in_card[_c, CARD_COMBOS[_c]] = np.arange(51)
POS_A = _pos_in_card[COMBO_A, np.arange(N_COMBOS)].astype(np.int32)  # コンボ i が a の列の何番目か
POS_B = _pos_in_card[COMBO_B, np.arange(N_COMBOS)].astype(np.int32)

_FRACTIONS = config.RAISE_FRACTIONS


# ---- ショーダウンの計算係 ----


def _valid_mask(cards) -> np.ndarray:
    ok = np.ones(N_COMBOS, dtype=bool)
    for c in cards:
        ok[CARD_COMBOS[int(c)]] = False
    return ok


def _board_strengths(board) -> np.ndarray:
    rows = np.empty((N_COMBOS, 2 + len(board)), dtype=np.int64)
    rows[:, 0] = COMBO_A
    rows[:, 1] = COMBO_B
    rows[:, 2:] = np.array(board, dtype=np.int64)[None, :]
    s = hand_values(rows)
    s[~_valid_mask(board)] = -1
    return s


@dataclass
class RunoutLeaf:
    """K 枚のボードそれぞれについて R 枚のランアウト（5 枚のボード）のショーダウンを持つ。"""

    K: int
    R: int
    order: np.ndarray  # (K, R, n) 強さの昇順のコンボ番号
    lo: np.ndarray  # (K, R, n) コンボ i より弱いものの数（並びの中の位置）
    hi: np.ndarray  # (K, R, n) コンボ i 以下のものの数
    card_sorted: np.ndarray  # (K, R, 52, 51) カード c を含むコンボを強さ順に
    lo_a: np.ndarray  # (K, R, n) a の列の中で i より弱いものの数
    lo_b: np.ndarray
    hi_a: np.ndarray
    hi_b: np.ndarray
    valid: np.ndarray  # (K, R, n) float32 そのランアウトでコンボ i が使えるか
    norm: np.ndarray  # (K,) 平均の分母

    @classmethod
    def build(cls, boards: list[list[tuple[int, ...]]], unknown: int | None = None) -> "RunoutLeaf":
        """`boards[k][r]` = 5 枚のボード。すべての k で r の数は同じにする。

        `unknown` は「ランアウトを取る前のボードから見た、まだ見えていないカードの枚数」
        （ターンなら 48）。ランアウトが 1 枚ずつ（リバー）で全部そろっているとき、相手のコンボ j との
        組で使えるランアウトは unknown − 4 枚（i の 2 枚と j の 2 枚を除く）。見本で R 枚だけ
        取っているときは、その割合 R × (unknown − 4) / unknown で近似する。R = 1 はそのまま。
        """
        K = len(boards)
        R = len(boards[0])
        n = N_COMBOS
        if R == 1:
            norm = np.ones(K, dtype=np.float32)
        else:
            u = unknown if unknown is not None else R
            norm = np.full(K, R * (u - 4) / u, dtype=np.float32)
        order = np.empty((K, R, n), dtype=np.int32)
        lo = np.empty((K, R, n), dtype=np.int32)
        hi = np.empty((K, R, n), dtype=np.int32)
        card_sorted = np.empty((K, R, 52, 51), dtype=np.int32)
        lo_a = np.empty((K, R, n), dtype=np.int32)
        lo_b = np.empty((K, R, n), dtype=np.int32)
        hi_a = np.empty((K, R, n), dtype=np.int32)
        hi_b = np.empty((K, R, n), dtype=np.int32)
        valid = np.empty((K, R, n), dtype=np.float32)
        for k in range(K):
            for r in range(R):
                s = _board_strengths(boards[k][r])
                valid[k, r] = (s >= 0).astype(np.float32)
                o = np.argsort(s, kind="stable")
                order[k, r] = o
                ss = s[o]
                lo[k, r] = np.searchsorted(ss, s, side="left")
                hi[k, r] = np.searchsorted(ss, s, side="right")
                sc = s[CARD_COMBOS]  # (52, 51)
                oc = np.argsort(sc, axis=1, kind="stable")
                card_sorted[k, r] = np.take_along_axis(CARD_COMBOS, oc, axis=1)
                scs = np.take_along_axis(sc, oc, axis=1)
                lo_c = np.empty((52, 51), dtype=np.int32)
                hi_c = np.empty((52, 51), dtype=np.int32)
                for c in range(52):
                    lo_c[c] = np.searchsorted(scs[c], sc[c], side="left")
                    hi_c[c] = np.searchsorted(scs[c], sc[c], side="right")
                lo_a[k, r] = lo_c[COMBO_A, POS_A]
                lo_b[k, r] = lo_c[COMBO_B, POS_B]
                hi_a[k, r] = hi_c[COMBO_A, POS_A]
                hi_b[k, r] = hi_c[COMBO_B, POS_B]
        return cls(K, R, order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm)


@njit(cache=True)
def _showdown_one(w, order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, out, cum, cumc):
    """1 枚のボードのショーダウン。`out[i]` = Σ_j w_j sign(強さ_i − 強さ_j)（かぶる j は除く）。

    `w` はこのランアウトで使えない相手のコンボを 0 にしてから渡す。
    `cum` (n+1,) と `cumc` (52, 52) は作業用。
    """
    n = w.shape[0]
    cum[0] = 0.0
    for p in range(n):
        cum[p + 1] = cum[p] + w[order[p]]
    total = cum[n]
    for c in range(52):
        cumc[c, 0] = 0.0
        for p in range(51):
            cumc[c, p + 1] = cumc[c, p] + w[card_sorted[c, p]]
    for i in range(n):
        if valid[i] == 0.0:
            out[i] = 0.0
            continue
        a = COMBO_A[i]
        b = COMBO_B[i]
        wins = cum[lo[i]] - cumc[a, lo_a[i]] - cumc[b, lo_b[i]]
        loses = (total - cum[hi[i]]) - (cumc[a, 51] - cumc[a, hi_a[i]]) - (cumc[b, 51] - cumc[b, hi_b[i]])
        out[i] = wins - loses


@njit(cache=True)
def _leaf_value(k, w, order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm, out,
                wr, tmp, cum, cumc):
    """ボード k について、R 枚のランアウトのショーダウンを合計し、`norm[k]` で割って `out` に入れる。

    `norm[k]` は「相手のコンボ j との組で見た、使えるランアウトの枚数」（`RunoutLeaf.build` 参照）。
    i ごとの枚数で割ると、降りたときの値に対してショーダウンの値が縮んでしまう。
    """
    n = w.shape[0]
    R = order.shape[1]
    for i in range(n):
        out[i] = 0.0
    for r in range(R):
        v = valid[k, r]
        for i in range(n):
            wr[i] = w[i] * v[i]
        _showdown_one(wr, order[k, r], lo[k, r], hi[k, r], card_sorted[k, r], lo_a[k, r], lo_b[k, r],
                      hi_a[k, r], hi_b[k, r], v, tmp, cum, cumc)
        for i in range(n):
            if v[i] != 0.0:
                out[i] += tmp[i]
    inv = 1.0 / norm[k]
    for i in range(n):
        out[i] *= inv


@njit(cache=True)
def _compat_sum(w, out, s):
    """`out[i]` = i とカードがかぶらない j の w の合計。`s` (52,) は作業用。"""
    n = w.shape[0]
    total = 0.0
    for c in range(52):
        s[c] = 0.0
    for i in range(n):
        total += w[i]
        s[COMBO_A[i]] += w[i]
        s[COMBO_B[i]] += w[i]
    for i in range(n):
        out[i] = total - s[COMBO_A[i]] - s[COMBO_B[i]] + w[i]


@njit(cache=True)
def _walk_one(k, K, n0, n1, ntype, player, n_act, child, stake, winner, reg_off, regret,
              order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm,
              reach_me, reach_opp, value, wr, tmp, cum, cumc, s52, me):
    """ボード k について、ノード [n0, n1) の木を 1 回走査する。`reach_*[0]` に根の到達確率を入れておく。

    `reach_me` / `reach_opp` / `value` は木ごとの作業用で、ノード番号から n0 を引いて使う。

    戻り値は `value[n0]`（`me` の反実仮想の価値）。`me` の決定ノードの後悔を更新する。
    戦略は前向きに計算して子の到達確率に掛け、後ろ向きにもう一度後悔から作り直す
    （その間に後悔は変わらないので同じ値になる。配列に置いておくより速い）。
    """
    n = reach_me.shape[1]
    for node in range(n0, n1):
        if ntype[node] != T_DECISION:
            continue
        na = n_act[node]
        off = reg_off[node]
        mine = player[node] == me
        for i in range(n):
            tot = 0.0
            for a in range(na):
                r = regret[off + (a * K + k) * n + i]
                if r > 0.0:
                    tot += r
            for a in range(na):
                c = child[node, a]
                if tot > 0.0:
                    r = regret[off + (a * K + k) * n + i]
                    p = r / tot if r > 0.0 else 0.0
                else:
                    p = 1.0 / na
                if mine:
                    reach_me[c - n0, i] = reach_me[node - n0, i] * p
                    reach_opp[c - n0, i] = reach_opp[node - n0, i]
                else:
                    reach_me[c - n0, i] = reach_me[node - n0, i]
                    reach_opp[c - n0, i] = reach_opp[node - n0, i] * p
    for node in range(n1 - 1, n0 - 1, -1):
        t = ntype[node]
        if t == T_FOLD:
            _compat_sum(reach_opp[node - n0], tmp, s52)
            sign = stake[node] if winner[node] == me else -stake[node]
            for i in range(n):
                value[node - n0, i] = sign * tmp[i]
        elif t == T_SHOWDOWN:
            _leaf_value(k, reach_opp[node - n0], order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b,
                        valid, norm, tmp, wr, value[node - n0], cum, cumc)
            for i in range(n):
                value[node - n0, i] = stake[node] * tmp[i]
        else:
            na = n_act[node]
            off = reg_off[node]
            if player[node] == me:
                for i in range(n):
                    tot = 0.0
                    for a in range(na):
                        r = regret[off + (a * K + k) * n + i]
                        if r > 0.0:
                            tot += r
                    v = 0.0
                    for a in range(na):
                        if tot > 0.0:
                            r = regret[off + (a * K + k) * n + i]
                            p = r / tot if r > 0.0 else 0.0
                        else:
                            p = 1.0 / na
                        v += p * value[child[node, a] - n0, i]
                    value[node - n0, i] = v
                    for a in range(na):
                        regret[off + (a * K + k) * n + i] += value[child[node, a] - n0, i] - v
            else:
                for i in range(n):
                    v = 0.0
                    for a in range(na):
                        v += value[child[node, a] - n0, i]
                    value[node - n0, i] = v


@njit(parallel=True, cache=True)
def walk_multi(K, tree_start, ntype, player, n_act, child, stake, winner, reg_off, regret,
               order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm,
               reach_me0, reach_opp0, me, out, sc_me, sc_opp, sc_val):
    """T 本の木 × K 枚のボードをまとめて 1 回走査する。

    `reach_*0` と `out` は (T, K, n)。`sc_*` はスレッドごとの作業用 (スレッド数, 最大ノード数, n)。
    木とボードの組（T × K 個）を並列に回す。
    """
    n_trees = tree_start.shape[0] - 1
    n = reach_me0.shape[2]
    for task in prange(n_trees * K):
        tree = task // K
        k = task - tree * K
        tid = numba.get_thread_id()
        reach_me = sc_me[tid]
        reach_opp = sc_opp[tid]
        value = sc_val[tid]
        wr = np.empty(n, dtype=np.float32)
        tmp = np.empty(n, dtype=np.float32)
        cum = np.empty(n + 1, dtype=np.float32)
        cumc = np.empty((52, 52), dtype=np.float32)
        s52 = np.empty(52, dtype=np.float32)
        n0 = tree_start[tree]
        n1 = tree_start[tree + 1]
        for i in range(n):
            reach_me[0, i] = reach_me0[tree, k, i]
            reach_opp[0, i] = reach_opp0[tree, k, i]
        _walk_one(k, K, n0, n1, ntype, player, n_act, child, stake, winner, reg_off, regret,
                  order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm,
                  reach_me, reach_opp, value, wr, tmp, cum, cumc, s52, me)
        for i in range(n):
            out[tree, k, i] = value[0, i]


@njit(parallel=True, cache=True)
def leaf_values(w, board, order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm, out):
    """(T, n) の相手の重み → それぞれ `board[t]` 番のボードでランアウトを平均したショーダウンの値 (T, n)。"""
    T = w.shape[0]
    n = w.shape[1]
    for t in prange(T):
        wr = np.empty(n, dtype=np.float32)
        tmp = np.empty(n, dtype=np.float32)
        cum = np.empty(n + 1, dtype=np.float32)
        cumc = np.empty((52, 52), dtype=np.float32)
        _leaf_value(board[t], w[t], order, lo, hi, card_sorted, lo_a, lo_b, hi_a, hi_b, valid, norm,
                    out[t], wr, tmp, cum, cumc)


@njit(parallel=True, cache=True)
def discount(regret, pos, neg):
    """DCFR の割引。正の後悔を pos 倍、負の後悔を neg 倍。"""
    for i in prange(regret.shape[0]):
        r = regret[i]
        regret[i] = r * pos if r > 0.0 else r * neg


# ---- 木を平らにする ----


@dataclass
class FlatTree:
    """1 ストリートぶんの賭けの木（チャンスノード無し）を配列にしたもの。K 枚のボードで共有する。"""

    ntype: np.ndarray
    player: np.ndarray
    n_act: np.ndarray
    child: np.ndarray  # (n_nodes, A_MAX)
    actions: list[list[int]]  # 決定ノードごとの枠の番号
    stake: np.ndarray
    winner: np.ndarray
    reg_off: np.ndarray
    regret_size: int
    K: int

    def __post_init__(self):
        self.regret = np.zeros(self.regret_size, dtype=np.float32)


def build_flat(st: State, raises: int, K: int, max_raises: int,
               fractions: tuple[float, ...] = _FRACTIONS) -> FlatTree:
    """`st`（ストリートの手番）から、このストリートの賭けの木を平らに組む。

    ストリートが終わるところと、降りずに終わるところはショーダウン（ランアウトの葉）。
    `fractions` は賭け額の倍率（最後にオールインが付く）。
    """
    ntype: list[int] = []
    player: list[int] = []
    n_act: list[int] = []
    child: list[list[int]] = []
    actions: list[list[int]] = []
    stake: list[float] = []
    winner: list[int] = []

    def add(t: int, p: int = 0, s: float = 0.0, w: int = 0) -> int:
        ntype.append(t)
        player.append(p)
        n_act.append(0)
        child.append([-1] * A_MAX)
        actions.append([])
        stake.append(s)
        winner.append(w)
        return len(ntype) - 1

    def rec(s: State, r: int) -> int:
        mask = legal_mask(s, fractions, max_raises, r)
        node = add(T_DECISION, s.to_act)
        acts = [i for i, ok in enumerate(mask) if ok]
        actions[node] = acts
        n_act[node] = len(acts)
        for a, i in enumerate(acts):
            nxt = apply_action(s, action_from_index(s, i, fractions))
            stk = float(min(nxt.committed))
            if nxt.finished and nxt.folded >= 0:
                c = add(T_FOLD, 0, stk, 1 - nxt.folded)
            elif nxt.finished or nxt.street != s.street:
                c = add(T_SHOWDOWN, 0, stk)
            else:
                c = rec(nxt, r + (1 if i >= IDX_RAISE_BASE else 0))
            child[node][a] = c
        return node

    rec(st, raises)
    n_nodes = len(ntype)
    reg_off = np.zeros(n_nodes, dtype=np.int64)
    off = 0
    for i in range(n_nodes):
        if ntype[i] == T_DECISION:
            reg_off[i] = off
            off += n_act[i] * K * N_COMBOS
    return FlatTree(
        ntype=np.array(ntype, dtype=np.int8), player=np.array(player, dtype=np.int8),
        n_act=np.array(n_act, dtype=np.int8), child=np.array(child, dtype=np.int32),
        actions=actions, stake=np.array(stake, dtype=np.float32),
        winner=np.array(winner, dtype=np.int8), reg_off=reg_off, regret_size=off, K=K,
    )


class MultiTree:
    """`solver.Chance` の子をまとめたもの。T 本の木 × K 枚のボードを 1 回の呼び出しで走査する。

    後悔は全部まとめて 1 本の配列に持つ（割引も 1 回で済む）。
    """

    def __init__(self, trees: list[FlatTree], leaf: RunoutLeaf):
        assert trees and all(t.K == leaf.K for t in trees)
        self.K = leaf.K
        self.leaf = leaf
        self.n_trees = len(trees)
        starts = [0]
        for t in trees:
            starts.append(starts[-1] + len(t.ntype))
        self.tree_start = np.array(starts, dtype=np.int64)
        self.ntype = np.concatenate([t.ntype for t in trees])
        self.player = np.concatenate([t.player for t in trees])
        self.n_act = np.concatenate([t.n_act for t in trees])
        child = []
        reg_off = []
        base = 0
        for s0, t in zip(starts, trees):
            c = t.child.copy()
            c[c >= 0] += s0
            child.append(c)
            r = t.reg_off.copy()
            r[t.ntype == T_DECISION] += base
            reg_off.append(r)
            base += t.regret_size
        self.child = np.concatenate(child)
        self.reg_off = np.concatenate(reg_off)
        self.stake = np.concatenate([t.stake for t in trees])
        self.winner = np.concatenate([t.winner for t in trees])
        self.regret = np.zeros(base, dtype=np.float32)
        self.max_nodes = max(len(t.ntype) for t in trees)
        self._scratch: tuple | None = None

    def _get_scratch(self) -> tuple:
        if self._scratch is None:
            nt = numba.get_num_threads()
            shape = (nt, self.max_nodes, N_COMBOS)
            self._scratch = (np.empty(shape, dtype=np.float32), np.empty(shape, dtype=np.float32),
                             np.empty(shape, dtype=np.float32))
        return self._scratch

    def walk(self, reach_me: np.ndarray, reach_opp: np.ndarray, me: int) -> np.ndarray:
        """(T, K, n) の到達確率 → `me` の価値 (T, K, n)。`me` の後悔を更新する。"""
        lf = self.leaf
        out = np.empty_like(reach_me, dtype=np.float32)
        sc_me, sc_opp, sc_val = self._get_scratch()
        walk_multi(self.K, self.tree_start, self.ntype, self.player, self.n_act, self.child,
                   self.stake, self.winner, self.reg_off, self.regret,
                   lf.order, lf.lo, lf.hi, lf.card_sorted, lf.lo_a, lf.lo_b, lf.hi_a, lf.hi_b,
                   lf.valid, lf.norm, np.ascontiguousarray(reach_me, dtype=np.float32),
                   np.ascontiguousarray(reach_opp, dtype=np.float32), me, out, sc_me, sc_opp, sc_val)
        return out

    def discount(self, pos: float, neg: float) -> None:
        discount(self.regret, np.float32(pos), np.float32(neg))


class LeafOnly:
    """ランアウトの葉だけ（層 0 のショーダウン用）。`value(w)` は (T, n) → (T, n)（全部ボード 0）。"""

    def __init__(self, leaf: RunoutLeaf):
        self.leaf = leaf

    def value(self, w: np.ndarray) -> np.ndarray:
        lf = self.leaf
        w = np.ascontiguousarray(w, dtype=np.float32)
        out = np.empty_like(w)
        board = np.zeros(w.shape[0], dtype=np.int64)
        leaf_values(w, board, lf.order, lf.lo, lf.hi, lf.card_sorted, lf.lo_a, lf.lo_b, lf.hi_a,
                    lf.hi_b, lf.valid, lf.norm, out)
        return out
