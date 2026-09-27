"""その場で解く（サブゲーム・ソルバー）。GTO Wizard などの「ソルバー」と同じ考え方。

学習したネット（Deep CFR）は、全部の局面を 1 つのネットで**だいたい**覚えたものにすぎない。
一方ソルバーは、**いま目の前にある局面だけ**を、両者の「持ちうる手の分布（レンジ）」を
1326 通りのホールカード全部について同時に計算しながら、CFR+ で解く。
局面を絞るぶん、同じ計算量でもはるかに均衡（ナッシュ均衡）に近い打ち方が出る。
Libratus / Pluribus が人間に勝ったときの「その場で読み直す」部分に当たる。

**作り**

- 手は 1326 通りのホールカードの組（コンボ）で持つ。レンジは長さ 1326 の重みの配列。
- 木は「いまのストリートの賭け」を組む（`build_tree`）。ストリートが終わったところは
  - リバーなら本当のショーダウン
  - ターンなら、リバーのカード 48 通りそれぞれについて**リバーの賭けまで組む**（`turn_rivers`。
    下の木は `fastcfr.py` の numba で回す）か、「そのままショーダウンしたときの期待値」で打ち切る
  - フロップなら、ターンのカードを見本で何枚か取り、それぞれについて**ターンの賭けまで組む**
    （`flop_turns`。リバーはそのままショーダウン）か、深さ制限で打ち切る
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
    IDX_CHECK_CALL, IDX_FOLD, IDX_RAISE_BASE, RIVER, Action, State, action_from_index,
    apply_action, legal_mask, to_call,
)
from . import config
from . import fastcfr
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

# ソルバーの賭け額の枠。**ネット（学習）の枠とは別**に持てる。ソルバーは局面ごとに木を組むので、
# 枠を足しても学習し直しは要らない。ネットの枠（0.5・1 ポット）は必ず含めておくと、
# 相手の行動（履歴はネットの枠で来る）をそのまま自分の枠に読み替えられる
BET_FRACTIONS = (0.33, 0.5, 0.75, 1.0, 1.5)  # そのストリートで最初に賭けるとき
RAISE_FRACTIONS_SOLVER = (1.0,)  # 相手の賭けに上乗せするとき（枠を絞って木を小さく保つ）
SUB_FRACTIONS = (0.5, 1.0)  # 先読み（次のストリートの木）の中


class ActionSpace:
    """ソルバーの手の並び: 0 = 降りる、1 = チェック/コール、2.. = 倍率、最後 = オールイン。

    局面ごとに使える倍率は変わる（ベットかレイズか）が、番号はこの並びで固定する。
    """

    def __init__(self, fractions: tuple[float, ...]):
        self.fractions = tuple(sorted(set(fractions)))
        self.n = IDX_RAISE_BASE + len(self.fractions) + 1
        self.all_in = self.n - 1

    def index_of(self, frac: float) -> int:
        return IDX_RAISE_BASE + self.fractions.index(frac)

    def labels(self) -> list[str]:
        return ["降りる", "チェック/コール"] + [f"ポットの{f:g}倍" for f in self.fractions] + ["オールイン"]

    def from_net(self, net_index: int) -> int:
        """ネットの枠の番号（履歴に入っている）→ この並びの番号。"""
        if net_index in (IDX_FOLD, IDX_CHECK_CALL):
            return net_index
        if net_index == len(_FRACTIONS) + IDX_RAISE_BASE:  # ネットのオールイン
            return self.all_in
        frac = _FRACTIONS[net_index - IDX_RAISE_BASE]
        if frac in self.fractions:
            return self.index_of(frac)
        return min(range(len(self.fractions)), key=lambda i: abs(self.fractions[i] - frac)) + IDX_RAISE_BASE

    def action(self, st: State, index: int) -> Action:
        """番号 → 実際の手（`to` つき）。"""
        if index in (IDX_FOLD, IDX_CHECK_CALL) or index == self.all_in:
            local = index if index != self.all_in else len(self.fractions) + IDX_RAISE_BASE
            return action_from_index(st, local, self.fractions)
        return action_from_index(st, index, self.fractions)


def node_actions(st: State, raises: int, max_raises: int, space: ActionSpace,
                 bet: tuple[float, ...], raise_: tuple[float, ...]) -> list[tuple[int, Action]]:
    """この局面で打てる手（ソルバーの番号と実際の手）。まだ誰も賭けていなければ `bet` の倍率、
    相手の賭けがあれば `raise_` の倍率を使う。同じ額になる枠は 1 つだけ残す。"""
    fracs = bet if to_call(st) == 0 else raise_
    fracs = tuple(f for f in fracs if f in space.fractions)
    mask = legal_mask(st, fracs, max_raises, raises)
    out: list[tuple[int, Action]] = []
    n_local = len(mask)
    for i, ok in enumerate(mask):
        if not ok:
            continue
        act = action_from_index(st, i, fracs)
        if i == IDX_FOLD or i == IDX_CHECK_CALL:
            out.append((i, act))
        elif i == n_local - 1:
            out.append((space.all_in, act))
        else:
            out.append((space.index_of(fracs[i - IDX_RAISE_BASE]), act))
    return out


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
        """(T, n) の相手の重み → (T, n) の「勝ち − 負け」の重み付き合計。

        T は K か、K = 1 なら何行でもよい（同じボードで何組もまとめて計算する）。
        """
        k = w.shape[0]
        b = lambda a: np.broadcast_to(a, (k, a.shape[1]))  # noqa: E731  K = 1 のときは行を使い回す
        ws = np.take_along_axis(w, b(self.order), axis=1)
        cum = np.zeros((k, N_COMBOS + 1), dtype=np.float32)
        np.cumsum(ws, axis=1, out=cum[:, 1:])
        total = cum[:, -1:]
        wins = np.take_along_axis(cum, b(self.lo), axis=1)
        loses = total - np.take_along_axis(cum, b(self.hi), axis=1)
        wc = np.take_along_axis(w, b(self.card_sorted), axis=1).reshape(k, 52, 51)
        cumc = np.zeros((k, 52, 52), dtype=np.float32)
        np.cumsum(wc, axis=2, out=cumc[:, :, 1:])
        flat = cumc.reshape(k, 52 * 52)
        wins -= np.take_along_axis(flat, b(self.lo_a), axis=1)
        wins -= np.take_along_axis(flat, b(self.lo_b), axis=1)
        tot_a = np.take_along_axis(flat, b(self.tot_a), axis=1)
        tot_b = np.take_along_axis(flat, b(self.tot_b), axis=1)
        loses -= tot_a - np.take_along_axis(flat, b(self.hi_a), axis=1)
        loses -= tot_b - np.take_along_axis(flat, b(self.hi_b), axis=1)
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


@lru_cache(maxsize=16)
def next_cards(board: tuple[int, ...], max_cards: int) -> tuple[int, ...]:
    """次にめくれるカードの候補。多すぎるときは見本で取る（ボードから決まる乱数）。"""
    rest = _unknown(board)
    if len(rest) > max_cards:
        rng = np.random.default_rng(_board_seed(board) ^ 0x5A5A)
        rest = sorted(int(c) for c in rng.choice(rest, size=max_cards, replace=False))
    return tuple(rest)


@lru_cache(maxsize=16)
def river_boards_leaf(board: tuple[int, ...], max_cards: int) -> fastcfr.RunoutLeaf:
    """ターンのボード → リバーのボードそれぞれ（K 枚、ランアウトは自分自身 1 つ）のショーダウン。"""
    cards = next_cards(board, max_cards)
    return fastcfr.RunoutLeaf.build([[tuple(board) + (c,)] for c in cards])


@lru_cache(maxsize=16)
def runout_leaf(board: tuple[int, ...]) -> fastcfr.LeafOnly:
    """ターンのボード → リバー全部を平均したショーダウン（オールインや深さ制限の葉）。厳密。"""
    cards = next_cards(board, 99)
    return fastcfr.LeafOnly(fastcfr.RunoutLeaf.build([[tuple(board) + (c,) for c in cards]],
                                                     unknown=52 - len(board)))


@lru_cache(maxsize=8)
def turn_boards_leaf(board: tuple[int, ...], max_cards: int, max_rivers: int) -> fastcfr.RunoutLeaf:
    """フロップのボード → ターンのボードそれぞれ（K 枚）について、リバー（見本）を平均したショーダウン。"""
    turns = next_cards(board, max_cards)
    boards = []
    for t in turns:
        tb = tuple(board) + (t,)
        boards.append([tb + (c,) for c in next_cards(tb, max_rivers)])
    return fastcfr.RunoutLeaf.build(boards, unknown=52 - len(board) - 1)


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
    """ストリートの終わり。次のカードの候補それぞれについて下の木を持つ。

    下の木そのものは `Layer0.multi`（`fastcfr.MultiTree`）の `index` 番目。
    `norm` は平均の分母の補正。コンボ i から見て使えるカードは U − 2 枚だが、相手のコンボ j との
    組で見ると U − 4 枚なので、(U − 4)/(U − 2) を掛けて「組ごとの枚数」で割ったことにする
    （`fastcfr._leaf_value` と同じ理由）。
    """

    index: int
    valid: np.ndarray  # (K1, n) そのカードとかぶらないコンボ
    norm: float = 1.0


@dataclass
class Decision:
    player: int
    actions: list[int]  # ソルバーの手の番号（`ActionSpace`）
    children: list = field(default_factory=list)
    moves: list = field(default_factory=list)  # `actions` と同じ並びの実際の手（`Action`）
    regret: np.ndarray | None = None
    ssum: np.ndarray | None = None


@dataclass
class SolveSettings:
    iterations: int = 200
    flop_runouts: int = 100  # フロップの深さ制限の葉（オールイン）で平均するランアウトの見本の数
    turn_rivers: int = 0  # ターンで、リバーの賭けまで組むときのリバーの候補の数（0 = 深さ制限、48 = 全部）
    flop_turns: int = 0  # フロップで、ターンの賭けまで組むときのターンの候補の数（0 = 深さ制限）
    max_raises: int = _MAX_RAISES
    # 次のストリートの木のレイズの回数の上限。1 にすると「ベット → レイズ → コール/降りる」までで、
    # ノードが 26 から 8 に減って 3 倍速い。そのストリートに実際に来たら改めて解くので、
    # 先読みの中では粗くてよい
    sub_max_raises: int = 1
    # フロップの先読みで、ターンの木の葉（リバーはそのままショーダウン）で平均するリバーの見本の数
    leaf_rivers: int = 16
    # 賭け額の枠（ネットの枠とは別）。最初のベット・レイズ・先読みの中で使う倍率
    bet_fractions: tuple[float, ...] = BET_FRACTIONS
    raise_fractions: tuple[float, ...] = RAISE_FRACTIONS_SOLVER
    sub_fractions: tuple[float, ...] = SUB_FRACTIONS

    def space(self) -> ActionSpace:
        return ActionSpace(self.bet_fractions + self.raise_fractions + self.sub_fractions)
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


@dataclass
class Layer0:
    """層 0 の木（Python のオブジェクト）と、下の木（numba でまとめて走査する `MultiTree`）。

    走査は再帰ではなく 2 パスで行う。前向きに到達確率を配り、チャンスノードの分は
    まとめて 1 回 numba に渡し（ここが重い）、後ろ向きに価値と後悔を集める。
    """

    root: Decision
    order: list  # 前順（親が先）のノードの並び
    chances: list  # Chance ノード（`MultiTree` の木の番号の順）
    multi: object | None  # fastcfr.MultiTree
    space: ActionSpace


def build_tree(st: State, raises: int, settings: SolveSettings) -> Layer0:
    """`st`（手番の局面）から、このストリートの賭けの木を組む（層 0）。

    ストリートの終わりは、設定に応じて次のストリートの木（`fastcfr.MultiTree` の 1 本）につなぐか、
    「そのままショーダウン」の葉で打ち切る。
    """
    board = tuple(int(c) for c in st.board)
    unknown = 52 - len(board)
    if st.street == RIVER:
        leaf0 = river_showdown(board)
    elif st.street == RIVER - 1:
        leaf0 = runout_leaf(board)  # リバー 48 通りを平均（厳密）
    else:
        leaf0 = equity_leaf(board, settings.flop_runouts)
    # 次のストリートの木を組むか
    cards: tuple[int, ...] = ()
    next_leaf: fastcfr.RunoutLeaf | None = None
    if st.street == RIVER - 1 and settings.turn_rivers > 0:
        cards = next_cards(board, settings.turn_rivers)
        next_leaf = river_boards_leaf(board, settings.turn_rivers)
    elif st.street == RIVER - 2 and settings.flop_turns > 0:
        cards = next_cards(board, settings.flop_turns)
        next_leaf = turn_boards_leaf(board, settings.flop_turns, settings.leaf_rivers)
    valid = None
    if next_leaf is not None:
        valid = np.stack([valid_mask((c,)) for c in cards]).astype(np.float32)
    norm = (unknown - 4) / (unknown - 2)
    order: list = []
    chances: list = []
    flats: list = []
    space = settings.space()

    def rec(s: State, r: int) -> Decision:
        moves = node_actions(s, r, settings.max_raises, space, settings.bet_fractions,
                             settings.raise_fractions)
        node = Decision(player=s.to_act, actions=[i for i, _ in moves], moves=[a for _, a in moves])
        order.append(node)
        for i, act in moves:
            child = apply_action(s, act)
            stake = float(min(child.committed))
            if child.finished:
                if child.folded >= 0:
                    leaf = Fold(1 - child.folded, stake)
                else:
                    leaf = Showdown(stake, leaf0)
                node.children.append(leaf)
                order.append(leaf)
            elif child.street != s.street:
                if next_leaf is not None:
                    flats.append(fastcfr.build_flat(child, 0, len(cards), settings.sub_max_raises,
                                                    settings.sub_fractions))
                    ch = Chance(len(chances), valid, norm)
                    chances.append(ch)
                    node.children.append(ch)
                    order.append(ch)
                else:
                    leaf = Showdown(stake, leaf0)
                    node.children.append(leaf)
                    order.append(leaf)
            else:
                node.children.append(rec(child, r + (1 if i >= IDX_RAISE_BASE else 0)))
        node.regret = np.zeros((len(node.actions), 1, N_COMBOS), dtype=np.float32)
        node.ssum = np.zeros((len(node.actions), 1, N_COMBOS), dtype=np.float32)
        return node

    root = rec(st, raises)
    multi = fastcfr.MultiTree(flats, next_leaf) if flats else None
    return Layer0(root, order, chances, multi, space)


def _sigma(regret: np.ndarray) -> np.ndarray:
    pos = np.maximum(regret, 0.0)
    tot = pos.sum(axis=0, keepdims=True)
    n_actions = regret.shape[0]
    return np.where(tot > 0.0, pos / np.maximum(tot, 1e-30), 1.0 / n_actions)


def _traverse(layer: Layer0, reach_me: np.ndarray, reach_opp: np.ndarray, me: int, t: float,
              plus: bool) -> np.ndarray:
    """層 0 を 1 回走査して根の価値 (1, n) を返す。`me` の後悔と平均戦略を更新する。

    `plus` なら CFR+（後悔を 0 で切り、平均戦略は反復の番号で重み付け）。
    そうでなければ DCFR（割引は `solve()` が反復の終わりにまとめて掛ける）。
    """
    rm: dict = {id(layer.root): reach_me}
    ro: dict = {id(layer.root): reach_opp}
    sig: dict = {}
    # 前向き: 到達確率
    for node in layer.order:
        if not isinstance(node, Decision):
            continue
        sigma = _sigma(node.regret)
        sig[id(node)] = sigma
        r_me, r_opp = rm[id(node)], ro[id(node)]
        for a, child in enumerate(node.children):
            if node.player == me:
                rm[id(child)] = r_me * sigma[a]
                ro[id(child)] = r_opp
            else:
                rm[id(child)] = r_me
                ro[id(child)] = r_opp * sigma[a]
    # 葉: チャンスノードの下の木はまとめて 1 回で走査する
    values: dict = {}
    if layer.multi is not None:
        k = layer.multi.K
        in_me = np.empty((len(layer.chances), k, N_COMBOS), dtype=np.float32)
        in_opp = np.empty((len(layer.chances), k, N_COMBOS), dtype=np.float32)
        for j, ch in enumerate(layer.chances):
            in_me[j] = rm[id(ch)] * ch.valid
            in_opp[j] = ro[id(ch)] * ch.valid
        out = layer.multi.walk(in_me, in_opp, me)
        for j, ch in enumerate(layer.chances):
            values[id(ch)] = (out[j] * ch.valid).sum(axis=0, keepdims=True) / np.maximum(
                ch.valid.sum(axis=0, keepdims=True) * ch.norm, 1e-6)
    folds = [n for n in layer.order if isinstance(n, Fold)]
    if folds:
        w = np.concatenate([ro[id(n)] for n in folds])
        cs = compat_sum(w)
        for j, n in enumerate(folds):
            sign = 1.0 if n.winner == me else -1.0
            values[id(n)] = (sign * n.stake) * cs[j:j + 1]
    shows = [n for n in layer.order if isinstance(n, Showdown)]
    if shows:
        w = np.concatenate([ro[id(n)] for n in shows])
        sv = shows[0].leaf.value(w)
        for j, n in enumerate(shows):
            values[id(n)] = n.stake * sv[j:j + 1]
    # 後ろ向き: 価値と後悔
    for node in reversed(layer.order):
        if not isinstance(node, Decision):
            continue
        sigma = sig[id(node)]
        vals = np.stack([values[id(c)] for c in node.children])
        if node.player == me:
            node_val = (sigma * vals).sum(axis=0)
            node.regret += vals - node_val
            if plus:
                np.maximum(node.regret, 0.0, out=node.regret)
                node.ssum += t * rm[id(node)] * sigma
            else:
                node.ssum += rm[id(node)] * sigma
            values[id(node)] = node_val
        else:
            values[id(node)] = vals.sum(axis=0)
    return values[id(layer.root)]


def _decisions(node, out: list) -> list:
    """層 0 の決定ノードを集める。"""
    if isinstance(node, Decision):
        out.append(node)
        for c in node.children:
            _decisions(c, out)
    return out


@dataclass
class Solution:
    root: Decision
    hero: int
    space: ActionSpace

    def action(self, index: int) -> Action:
        """根の手の番号 → 実際の手。"""
        return self.root.moves[self.root.actions.index(index)]

    def strategy(self, combo: int) -> dict[int, float]:
        """根で、指定のコンボが各手（ソルバーの番号）を選ぶ確率（平均戦略）。"""
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
    layer = build_tree(st, raises, settings)
    ok = valid_mask(st.board).astype(np.float32)
    r = [np.asarray(ranges[p], dtype=np.float32) * ok for p in (0, 1)]
    for p in (0, 1):
        tot = float(r[p].sum())
        r[p] = (r[p] / tot if tot > 0 else ok / ok.sum())[None, :]
    plus = not settings.discount
    nodes = _decisions(layer.root, [])
    for t in range(1, settings.iterations + 1):
        for me in (0, 1):
            _traverse(layer, r[me], r[1 - me], me, float(t), plus)
        if plus:
            if layer.multi is not None:  # 下の木は numba の中で 0 で切っていないので、ここで切る
                layer.multi.discount(1.0, 0.0)
        else:
            ta = t ** settings.alpha
            tb = t ** settings.beta
            pos, neg = ta / (ta + 1.0), tb / (tb + 1.0)
            avg = (t / (t + 1.0)) ** settings.gamma
            for node in nodes:
                node.regret *= np.where(node.regret > 0.0, pos, neg)
                node.ssum *= avg
            if layer.multi is not None:
                layer.multi.discount(pos, neg)
    return Solution(layer.root, hero, layer.space)


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
        raise NotImplementedError("次のストリートの木を含む解の搾取されやすさは、まだ測れない")
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
