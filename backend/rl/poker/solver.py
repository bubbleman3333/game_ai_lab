"""その場で解く（サブゲーム・ソルバー）。GTO Wizard などの「ソルバー」と同じ考え方。

学習したネット（Deep CFR）は、全部の局面を 1 つのネットで**だいたい**覚えたものにすぎない。
一方ソルバーは、**いま目の前にある局面だけ**を、両者の「持ちうる手の分布（レンジ）」を
1326 通りのホールカード全部について同時に計算しながら、CFR+ で解く。
局面を絞るぶん、同じ計算量でもはるかに均衡（ナッシュ均衡）に近い打ち方が出る。
Libratus / Pluribus が人間に勝ったときの「その場で読み直す」部分に当たる。

**作り**

- 手は 1326 通りのホールカードの組（コンボ）で持つ。レンジは長さ 1326 の重みの配列。
- 木は「いまのストリートの賭け」だけを組む（`build_tree`）。ストリートが終わったところは
  - リバーなら本当のショーダウン
  - ターンなら、リバーのカード 48 通りそれぞれについてリバーの賭けまで組む（`turn_rivers`）か、
    「そのままショーダウンしたときの期待値」で打ち切る（深さ制限）
  - フロップは深さ制限（ランアウトを見本で取って平均した勝率で打ち切る）
- 期待値は**相手のレンジとの行列積**で 1326 通りまとめて求める。ショーダウンは
  「強さの順に並べて累積和を取る」やり方で、カードのかぶり（ブロッカー）も正しく引く。
- 反復は CFR+（後悔を 0 で切り、平均戦略は反復の番号で重み付け）。両者を交互に更新する。

数は全部 numpy の float32。1326 通り × リバー 48 通りでも数 MB に収まる。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from games.poker.rules import (
    IDX_RAISE_BASE, RIVER, State, action_from_index, apply_action, legal_mask,
)
from . import config
from .fasteval import hand_values

N_COMBOS = 1326
_c1, _c2 = np.triu_indices(52, 1)
#: コンボ番号 → 2 枚のカード（小さい方が先）
COMBO_CARDS = np.stack([_c1, _c2], axis=1).astype(np.int64)
#: 2 枚のカード → コンボ番号
COMBO_OF = np.full((52, 52), -1, dtype=np.int64)
COMBO_OF[_c1, _c2] = np.arange(N_COMBOS)
COMBO_OF[_c2, _c1] = np.arange(N_COMBOS)
#: (1326, 52) の 0/1。コンボ i がカード c を含むか
CARD_MATRIX = np.zeros((N_COMBOS, 52), dtype=np.float32)
CARD_MATRIX[np.arange(N_COMBOS), _c1] = 1.0
CARD_MATRIX[np.arange(N_COMBOS), _c2] = 1.0
#: カード c を含むコンボ 51 個の番号
CARD_COMBOS = np.stack([np.nonzero(CARD_MATRIX[:, c])[0] for c in range(52)]).astype(np.int64)
_A = COMBO_CARDS[:, 0]
_B = COMBO_CARDS[:, 1]

_FRACTIONS = config.RAISE_FRACTIONS
_MAX_RAISES = config.MAX_RAISES_PER_STREET


def combo_index(hole: tuple[int, int]) -> int:
    return int(COMBO_OF[hole[0], hole[1]])


def valid_mask(cards) -> np.ndarray:
    """見えているカード（ボードや自分の手札）とかぶらないコンボ。"""
    ok = np.ones(N_COMBOS, dtype=bool)
    for c in cards:
        ok[CARD_COMBOS[c]] = False
    return ok


def compat_sum(w: np.ndarray) -> np.ndarray:
    """各コンボ i について、i とカードがかぶらない j の重みの合計。(K, n) → (K, n)。

    全体 − a を含む分 − b を含む分 + 自分（a と b の両方を含むのは自分だけなので 2 回引かれる）。
    """
    s = w @ CARD_MATRIX  # (K, 52): カードごとの合計
    return w.sum(axis=1, keepdims=True) - s[:, _A] - s[:, _B] + w


def _strengths(board: tuple[int, ...], runouts: np.ndarray) -> np.ndarray:
    """(M, R) のランアウトごとに、1326 コンボの強さ (M, 1326)。かぶるコンボは -1。"""
    m = len(runouts)
    fixed = np.array(board, dtype=np.int64)
    rows = np.empty((m, N_COMBOS, 2 + len(board) + runouts.shape[1]), dtype=np.int64)
    rows[:, :, :2] = COMBO_CARDS[None]
    rows[:, :, 2:2 + len(board)] = fixed[None, None]
    rows[:, :, 2 + len(board):] = runouts[:, None, :]
    flat = rows.reshape(-1, rows.shape[2])
    out = np.empty(len(flat), dtype=np.int64)
    step = 150_000
    for i in range(0, len(flat), step):
        out[i:i + step] = hand_values(flat[i:i + step])
    values = out.reshape(m, N_COMBOS)
    invalid = ~valid_mask(board)[None, :].repeat(m, axis=0)
    for k in range(m):
        for c in runouts[k]:
            invalid[k, CARD_COMBOS[c]] = True
    values[invalid] = -1
    return values


#: 行列を低ランクに縮めるときのランク。160 で誤差は最大値の 0.3% ほど（`tests/poker/test_solver.py`）
LEAF_RANK = 160


def low_rank(matrix: np.ndarray, rank: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """(n, n) の行列を L (n, r) と R (r, n) に縮める（乱択 SVD、べき乗反復 1 回）。

    `matrix ≈ L @ R`。厳密な SVD は 1 秒かかるが、こちらは 0.1 秒ほど。
    """
    n = matrix.shape[0]
    rng = np.random.default_rng(seed)
    omega = rng.standard_normal((n, rank + 24)).astype(np.float32)
    y = matrix @ omega
    y = matrix @ (matrix.T @ y)  # べき乗反復で上位の成分をはっきりさせる
    q, _ = np.linalg.qr(y)
    b = q.T @ matrix  # (r+24, n)
    u, s, vt = np.linalg.svd(b, full_matrices=False)
    left = (q @ u[:, :rank]) * s[:rank]
    return left.astype(np.float32), vt[:rank].astype(np.float32)


class EquityLeaf:
    """ショーダウンの期待値を「ランアウトを平均した (n, n) の行列」で持つ。

    E[i, j] = 平均 sign(強さ_i − 強さ_j) ∈ [-1, 1]（i と j がかぶる組は 0）。
    値は `stake × (E @ 相手のレンジ)`。深さ制限の葉（そのままショーダウンしたとき）に使う。

    ランアウトを見本で取るとき、コンボ i がその見本にかぶることがある。かぶった見本は
    i の入る組から外して数えたい。1 つずつマスクすると遅いので、かぶるコンボの強さを
    -1（最弱）にして全部足してから、かぶった回数ぶんをまとめて差し引く（rank-1 の補正）。

    **行列は低ランクに縮めて持つ**（`LEAF_RANK`）。1326 × 1326 の float32 は 7MB あり、
    1 反復に何十回も掛けるとメモリの帯域で頭打ちになる（複数プロセスで並べたら
    まったく速くならなかった）。L (n, r) と R (r, n) にすれば 1.7MB で、計算も 5 分の 1。
    """

    def __init__(self, board: tuple[int, ...], runouts: np.ndarray, rank: int = LEAF_RANK,
                 keep_dense: bool = False):
        board = tuple(board)
        self.board = board
        self.dense: np.ndarray | None = None  # 縮める前の行列（`keep_dense` のとき。テスト用）
        m = len(runouts)
        strengths = _strengths(board, runouts)
        # 強さを密な順位（int16）にして引き算を軽くする
        total = np.zeros((N_COMBOS, N_COMBOS), dtype=np.int32)
        for k in range(m):
            _, dense = np.unique(strengths[k], return_inverse=True)
            r = dense.astype(np.int16)
            d = r[:, None] - r[None, :]
            np.sign(d, out=d)
            total += d
        # 補正: 何回かぶったか（h）と、i と j の両方にかぶった回数（both）
        hits = np.zeros(52, dtype=np.float64)
        pair = np.zeros((52, 52), dtype=np.float64)
        for cards in runouts:
            for c in cards:
                hits[c] += 1
            for x in cards:
                for y in cards:
                    if x != y:
                        pair[x, y] += 1
        h = hits[_A] + hits[_B] - pair[_A, _B]
        both = CARD_MATRIX.astype(np.float64) @ pair @ CARD_MATRIX.T.astype(np.float64)
        true_total = total.astype(np.float64) + h[:, None] - h[None, :]
        count = m - h[:, None] - h[None, :] + both
        e = true_total / np.maximum(count, 1.0)
        ok = valid_mask(board)
        e[~ok, :] = 0.0
        e[:, ~ok] = 0.0
        # かぶる組（カードを共有する i, j）は 0
        share = (CARD_MATRIX @ CARD_MATRIX.T) > 0
        e[share] = 0.0
        self.runouts = m
        if keep_dense:
            self.dense = e.astype(np.float32)
        self.set_matrix(e.astype(np.float32), rank)

    def set_matrix(self, matrix: np.ndarray, rank: int = LEAF_RANK) -> None:
        self.left, self.right = low_rank(matrix, rank)

    @property
    def matrix(self) -> np.ndarray:
        """縮める前の形に戻したもの（テストと調査用。近似）。"""
        return self.left @ self.right

    def value(self, w: np.ndarray) -> np.ndarray:
        """(1, n) の相手の重み → (1, n) の「勝ち − 負け」の重み付き合計。"""
        return (w @ self.right.T) @ self.left.T


class SortedShowdown:
    """K 枚のボード（リバーまで出ている）それぞれで、本当のショーダウンを速く計算する。

    強さの順に並べて累積和を取れば「自分より弱い相手の重みの合計」が一度に出る。
    カードがかぶる相手は数えてはいけないので、カードごとに「そのカードを含むコンボ」を
    同じく強さ順に並べた累積和を作り、そこから引く。
    """

    def __init__(self, boards: np.ndarray):
        boards = np.asarray(boards, dtype=np.int64)
        k = len(boards)
        s = np.empty((k, N_COMBOS), dtype=np.int64)
        for i in range(k):
            s[i] = _strengths(tuple(boards[i]), np.zeros((1, 0), dtype=np.int64))[0]
        self.valid = s >= 0
        self.order = np.argsort(s, axis=1, kind="stable")
        s_sorted = np.take_along_axis(s, self.order, axis=1)
        self.lo = np.empty((k, N_COMBOS), dtype=np.int64)
        self.hi = np.empty((k, N_COMBOS), dtype=np.int64)
        card_sorted = np.empty((k, 52, 51), dtype=np.int64)
        lo_c = np.empty((k, 52, 51), dtype=np.int64)  # そのカードを含む列の中での「自分より弱い数」
        hi_c = np.empty((k, 52, 51), dtype=np.int64)
        for i in range(k):
            self.lo[i] = np.searchsorted(s_sorted[i], s[i], side="left")
            self.hi[i] = np.searchsorted(s_sorted[i], s[i], side="right")
            sc = s[i][CARD_COMBOS]  # (52, 51)
            o = np.argsort(sc, axis=1, kind="stable")
            card_sorted[i] = np.take_along_axis(CARD_COMBOS, o, axis=1)
            scs = np.take_along_axis(sc, o, axis=1)
            for c in range(52):
                lo_c[i, c] = np.searchsorted(scs[c], sc[c], side="left")
                hi_c[i, c] = np.searchsorted(scs[c], sc[c], side="right")
        self.card_sorted = card_sorted.reshape(k, 52 * 51)
        # コンボ i の 2 枚 a, b について、「a の列の中の位置」を (52, 52) の累積和の平らな番号にする
        # CARD_COMBOS[c] の中で i が何番目か
        pos_in_card = np.zeros((52, N_COMBOS), dtype=np.int64)
        for c in range(52):
            pos_in_card[c, CARD_COMBOS[c]] = np.arange(51)
        pa = pos_in_card[_A, np.arange(N_COMBOS)]
        pb = pos_in_card[_B, np.arange(N_COMBOS)]
        self.lo_a = _A[None, :] * 52 + lo_c[:, _A, pa]
        self.lo_b = _B[None, :] * 52 + lo_c[:, _B, pb]
        self.hi_a = _A[None, :] * 52 + hi_c[:, _A, pa]
        self.hi_b = _B[None, :] * 52 + hi_c[:, _B, pb]
        self.tot_a = _A[None, :] * 52 + 51
        self.tot_b = _B[None, :] * 52 + 51
        self.k = k

    def value(self, w: np.ndarray) -> np.ndarray:
        """(K, n) の相手の重み → (K, n) の「勝ち − 負け」の重み付き合計。"""
        k = self.k
        ws = np.take_along_axis(w, self.order, axis=1)
        cum = np.zeros((k, N_COMBOS + 1), dtype=np.float32)
        np.cumsum(ws, axis=1, out=cum[:, 1:])
        total = cum[:, -1:]
        wins = np.take_along_axis(cum, self.lo, axis=1)
        loses = total - np.take_along_axis(cum, self.hi, axis=1)
        wc = np.take_along_axis(w, self.card_sorted, axis=1).reshape(k, 52, 51)
        cumc = np.zeros((k, 52, 52), dtype=np.float32)
        np.cumsum(wc, axis=2, out=cumc[:, :, 1:])
        flat = cumc.reshape(k, 52 * 52)
        wins -= np.take_along_axis(flat, self.lo_a, axis=1)
        wins -= np.take_along_axis(flat, self.lo_b, axis=1)
        tot_a = np.take_along_axis(flat, self.tot_a, axis=1)
        tot_b = np.take_along_axis(flat, self.tot_b, axis=1)
        loses -= tot_a - np.take_along_axis(flat, self.hi_a, axis=1)
        loses -= tot_b - np.take_along_axis(flat, self.hi_b, axis=1)
        return wins - loses


# ---- ランアウト（この先めくれるカード）の作り方 ----


def _unknown(board: tuple[int, ...]) -> list[int]:
    return [c for c in range(52) if c not in board]


def runouts_for(board: tuple[int, ...], max_samples: int, seed: int) -> np.ndarray:
    """ボードからリバーまでに足りないカードの組み合わせ。多すぎるときは見本で取る。"""
    need = 5 - len(board)
    rest = _unknown(board)
    if need == 0:
        return np.zeros((1, 0), dtype=np.int64)
    if need == 1:
        return np.array(rest, dtype=np.int64)[:, None]
    pairs = np.array([(a, b) for i, a in enumerate(rest) for b in rest[i + 1:]], dtype=np.int64)
    if len(pairs) <= max_samples:
        return pairs
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(pairs), size=max_samples, replace=False)
    return pairs[np.sort(pick)]


def _board_seed(board: tuple[int, ...]) -> int:
    seed = 7
    for c in sorted(board):
        seed = (seed * 53 + c + 1) & 0x7FFFFFFF
    return seed


def _cache_dir():
    from ..common import runs_dir

    return runs_dir("poker") / "_cache"


@lru_cache(maxsize=64)
def equity_leaf(board: tuple[int, ...], max_samples: int) -> EquityLeaf:
    """ボードごとに 1 回だけ作って使い回す（同じ局で何度も呼ぶため）。

    プリフロップ（ボード無し）は見本が多くて 15 秒ほどかかるので、ファイルにも残す。
    """
    board = tuple(int(c) for c in board)
    if not board:
        path = _cache_dir() / f"preflop_equity_{max_samples}_r{LEAF_RANK}.npz"
        try:
            blob = np.load(path)
            leaf = EquityLeaf.__new__(EquityLeaf)
            leaf.board = board
            leaf.left, leaf.right = blob["left"], blob["right"]
            leaf.runouts = max_samples
            return leaf
        except OSError:
            pass
        leaf = EquityLeaf(board, runouts_for(board, max_samples, _board_seed(board)))
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            np.savez(path, left=leaf.left, right=leaf.right)
        except OSError:
            pass
        return leaf
    return EquityLeaf(board, runouts_for(board, max_samples, _board_seed(board)))


@lru_cache(maxsize=64)
def river_layer(board: tuple[int, ...], max_rivers: int) -> tuple[np.ndarray, SortedShowdown]:
    """ターンのボード → リバーのカードの候補と、それぞれのショーダウンの計算係。"""
    rest = np.array(_unknown(board), dtype=np.int64)
    if len(rest) > max_rivers:
        rng = np.random.default_rng(_board_seed(board) ^ 0x5A5A)
        rest = np.sort(rng.choice(rest, size=max_rivers, replace=False))
    boards = np.array([tuple(board) + (int(c),) for c in rest], dtype=np.int64)
    return rest, SortedShowdown(boards)


# ---- 木 ----


@dataclass
class Fold:
    winner: int
    stake: float


@dataclass
class Showdown:
    stake: float
    leaf: object  # EquityLeaf か SortedShowdown（層に合わせたもの）


@dataclass
class Chance:
    """ストリートの終わり。次のカードの候補それぞれについて下の木を（まとめて）持つ。"""

    child: "Decision"
    valid: np.ndarray  # (K1, n) そのカードとかぶらないコンボ


@dataclass
class Decision:
    player: int
    actions: list[int]
    children: list = field(default_factory=list)
    regret: np.ndarray | None = None
    ssum: np.ndarray | None = None


@dataclass
class SolveSettings:
    iterations: int = 200
    flop_runouts: int = 100  # フロップの深さ制限の葉で平均するランアウトの見本の数
    turn_rivers: int = 0  # ターンで、リバーの賭けまで組むときのリバーの候補の数（0 = 深さ制限）
    max_raises: int = _MAX_RAISES
    # 後悔の割引（DCFR, Brown & Sandholm 2019）。CFR+ より少ない反復で均衡に近づく。
    # alpha: 正の後悔を t^alpha/(t^alpha+1) 倍、beta: 負の後悔を t^beta/(t^beta+1) 倍、
    # gamma: 平均戦略を (t/(t+1))^gamma 倍。discount=False なら CFR+（負の後悔を 0 で切る）
    discount: bool = True
    alpha: float = 1.5
    beta: float = 0.0
    gamma: float = 2.0


@lru_cache(maxsize=64)
def river_showdown(board: tuple[int, ...]) -> SortedShowdown:
    """リバーの本当のショーダウン（厳密で、行列を持たないので軽い）。"""
    return SortedShowdown(np.array([board], dtype=np.int64))


def build_tree(st: State, raises: int, settings: SolveSettings) -> Decision:
    """`st`（手番の局面）から、このストリートの賭けの木を組む。"""
    if st.street == RIVER:
        leaf0 = river_showdown(tuple(int(c) for c in st.board))
    else:
        leaf0 = equity_leaf(tuple(st.board), settings.flop_runouts)
    rivers = None
    if st.street == RIVER - 1 and settings.turn_rivers > 0:
        rivers = river_layer(tuple(st.board), settings.turn_rivers)

    def rec(s: State, r: int, layer: int) -> Decision:
        mask = legal_mask(s, _FRACTIONS, settings.max_raises, r)
        node = Decision(player=s.to_act, actions=[i for i, ok in enumerate(mask) if ok])
        for i in node.actions:
            child = apply_action(s, action_from_index(s, i, _FRACTIONS))
            stake = float(min(child.committed))
            if child.finished:
                if child.folded >= 0:
                    node.children.append(Fold(1 - child.folded, stake))
                else:
                    node.children.append(Showdown(stake, leaf0 if layer == 0 else rivers[1]))
            elif child.street != s.street:
                if layer == 0 and rivers is not None:
                    cards, _ = rivers
                    valid = np.stack([valid_mask((int(c),)) for c in cards]).astype(np.float32)
                    node.children.append(Chance(rec(child, 0, 1), valid))
                else:
                    node.children.append(Showdown(stake, leaf0 if layer == 0 else rivers[1]))
            else:
                node.children.append(rec(child, r + (1 if i >= IDX_RAISE_BASE else 0), layer))
        k = 1 if layer == 0 else len(rivers[0])
        node.regret = np.zeros((len(node.actions), k, N_COMBOS), dtype=np.float32)
        node.ssum = np.zeros((len(node.actions), k, N_COMBOS), dtype=np.float32)
        return node

    return rec(st, raises, 0)


def _sigma(regret: np.ndarray) -> np.ndarray:
    pos = np.maximum(regret, 0.0)
    tot = pos.sum(axis=0, keepdims=True)
    n_actions = regret.shape[0]
    return np.where(tot > 0.0, pos / np.maximum(tot, 1e-30), 1.0 / n_actions)


def _walk(node, reach_me: np.ndarray, reach_opp: np.ndarray, me: int, t: float,
          plus: bool) -> np.ndarray:
    """`me` の手それぞれの反実仮想の価値 (K, n)。`me` の後悔と平均戦略を更新する。

    `plus` なら CFR+（後悔を 0 で切り、平均戦略は反復の番号で重み付け）。
    そうでなければ DCFR（割引は `solve()` が反復の終わりにまとめて掛ける）。
    """
    if isinstance(node, Fold):
        sign = 1.0 if node.winner == me else -1.0
        return (sign * node.stake) * compat_sum(reach_opp)
    if isinstance(node, Showdown):
        return node.stake * node.leaf.value(reach_opp)
    if isinstance(node, Chance):
        v = _walk(node.child, reach_me * node.valid, reach_opp * node.valid, me, t, plus)
        return (v * node.valid).sum(axis=0, keepdims=True) / np.maximum(
            node.valid.sum(axis=0, keepdims=True), 1.0)
    sigma = _sigma(node.regret)
    if node.player == me:
        vals = np.stack([
            _walk(child, reach_me * sigma[a], reach_opp, me, t, plus)
            for a, child in enumerate(node.children)
        ])
        node_val = (sigma * vals).sum(axis=0)
        node.regret += vals - node_val
        if plus:
            np.maximum(node.regret, 0.0, out=node.regret)
            node.ssum += t * reach_me * sigma
        else:
            node.ssum += reach_me * sigma
        return node_val
    total = None
    for a, child in enumerate(node.children):
        v = _walk(child, reach_me, reach_opp * sigma[a], me, t, plus)
        total = v if total is None else total + v
    return total


def _decisions(node, out: list) -> list:
    if isinstance(node, Decision):
        out.append(node)
        for c in node.children:
            _decisions(c, out)
    elif isinstance(node, Chance):
        _decisions(node.child, out)
    return out


@dataclass
class Solution:
    root: Decision
    hero: int

    def strategy(self, combo: int) -> dict[int, float]:
        """根で、指定のコンボが各手（枠の番号）を選ぶ確率（平均戦略）。"""
        s = self.root.ssum[:, 0, combo]
        tot = float(s.sum())
        if tot <= 0.0:
            n = len(self.root.actions)
            return {a: 1.0 / n for a in self.root.actions}
        return {a: float(s[k] / tot) for k, a in enumerate(self.root.actions)}

    def range_strategy(self) -> np.ndarray:
        """根での全コンボの平均戦略 (A, n)。"""
        s = self.root.ssum[:, 0, :]
        tot = s.sum(axis=0, keepdims=True)
        return np.where(tot > 0.0, s / np.maximum(tot, 1e-30), 1.0 / len(self.root.actions))


def solve(st: State, hero: int, ranges: tuple[np.ndarray, np.ndarray], raises: int,
          settings: SolveSettings) -> Solution:
    """`st`（`hero` の手番）をレンジ付きで解く。`ranges[p]` は p の各コンボの重み (n,)。"""
    if st.to_act != hero:
        raise ValueError("手番でない側からは解けない")
    root = build_tree(st, raises, settings)
    ok = valid_mask(st.board).astype(np.float32)
    r = [np.asarray(ranges[p], dtype=np.float32) * ok for p in (0, 1)]
    for p in (0, 1):
        tot = float(r[p].sum())
        r[p] = (r[p] / tot if tot > 0 else ok / ok.sum())[None, :]
    plus = not settings.discount
    nodes = _decisions(root, [])
    for t in range(1, settings.iterations + 1):
        for me in (0, 1):
            _walk(root, r[me], r[1 - me], me, float(t), plus)
        if not plus:
            ta = t ** settings.alpha
            tb = t ** settings.beta
            pos, neg = ta / (ta + 1.0), tb / (tb + 1.0)
            avg = (t / (t + 1.0)) ** settings.gamma
            for node in nodes:
                node.regret *= np.where(node.regret > 0.0, pos, neg)
                node.ssum *= avg
    return Solution(root, hero)


# ---- 収束の確かめ方（テストと調整用） ----


def _avg_sigma(node: Decision) -> np.ndarray:
    tot = node.ssum.sum(axis=0, keepdims=True)
    return np.where(tot > 0.0, node.ssum / np.maximum(tot, 1e-30), 1.0 / len(node.actions))


def _walk_fixed(node, reach_opp: np.ndarray, me: int, best_response: bool) -> np.ndarray:
    """両者が平均戦略で打ったときの `me` の価値。`best_response` なら `me` は最善の受けを打つ。"""
    if isinstance(node, Fold):
        sign = 1.0 if node.winner == me else -1.0
        return (sign * node.stake) * compat_sum(reach_opp)
    if isinstance(node, Showdown):
        return node.stake * node.leaf.value(reach_opp)
    if isinstance(node, Chance):
        v = _walk_fixed(node.child, reach_opp * node.valid, me, best_response)
        return (v * node.valid).sum(axis=0, keepdims=True) / np.maximum(
            node.valid.sum(axis=0, keepdims=True), 1.0)
    sigma = _avg_sigma(node)
    if node.player == me:
        vals = np.stack([_walk_fixed(c, reach_opp, me, best_response) for c in node.children])
        if best_response:
            return vals.max(axis=0)
        return (sigma * vals).sum(axis=0)
    total = None
    for a, child in enumerate(node.children):
        v = _walk_fixed(child, reach_opp * sigma[a], me, best_response)
        total = v if total is None else total + v
    return total


def exploitability(sol: Solution, ranges: tuple[np.ndarray, np.ndarray], board) -> float:
    """このサブゲームの中で、平均戦略がどれだけ搾取されうるか（両者の最善の受けの平均、チップ）。

    0 に近いほど均衡に近い。レンジは `solve()` と同じように正規化して、
    「かぶらない組の重みの合計」で割るので、**1 局あたりのチップ**の単位になる。
    """
    ok = valid_mask(board).astype(np.float32)
    r = []
    for p in (0, 1):
        x = np.asarray(ranges[p], dtype=np.float32) * ok
        tot = float(x.sum())
        r.append((x / tot if tot > 0 else ok / ok.sum())[None, :])
    pair_weight = float((compat_sum(r[1]) * r[0]).sum())
    total = 0.0
    for me in (0, 1):
        br = _walk_fixed(sol.root, r[1 - me], me, True)
        total += float((br * r[me]).sum())
    return total / 2.0 / max(pair_weight, 1e-12)
