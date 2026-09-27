"""その場で解いて打つプレイヤー（`SearchPlayer`）。**これが AI の本体**。

GTO Wizard のような「ソルバーで解いた均衡戦略」を、対局中にその場で作る。

1. **レンジを持ち歩く**: 局の始まりは両者とも 1326 通りが同じ重み。行動が 1 つ進むたびに
   「その手札なら、その行動をどれだけの確率で選んだか」を掛けていく。
   - **自分の行動**は、自分が解いたときの平均戦略（1326 通りぶん出ている）で掛ける。
   - **相手の行動**は、2 つのモデルを混ぜる（`net_weight`）。
     - 学習したネット（Deep CFR の平均戦略）で「相手がこう打つ確率」を 1326 通りまとめて計算
     - ソルバーが出した**相手の均衡戦略**（自分が前に解いたときの木に相手の応手が入っている。
       プリフロップは相手の局面も解いた結果を使い回せる）
     ネットだけだと、ネットの想定が甘い手（たとえば 100BB のオールイン）を人間に
     「強い手だけで」打たれたときに、広く受けすぎて大きく損をする。均衡戦略を混ぜると
     「相手もそれなりに理にかなった打ち方をする」前提が入り、そこが締まる。
2. **解く**: 自分の手番で、いまの局面から先を `solver.solve()` で解き、
   自分の実際の手札の平均戦略から手を引く。

プリフロップは局面が少ない（スタックと履歴で決まる）ので、解いた結果を使い回す。
フロップ以降は毎回解く（1〜2 秒）。

相手が人間のとき、ネットの想定から外れた手（ネットなら絶対に打たない手）を打たれると
レンジが 0 になって解けなくなる。そこで小さな確率 `epsilon` でどの手も打ちうるとして混ぜる。

API（`apps/poker/services.py`）はリクエストごとにこのオブジェクトを作り直すので、
レンジは `dump_memo()` / `load_memo()` でテーブルに保存して持ち越す。
"""

from __future__ import annotations

import random
from functools import lru_cache

import numpy as np

from games.poker.rules import (
    BOARD_COUNT, PREFLOP, FLOP, TURN, RIVER, State, action_from_index, apply_action, legal_mask,
    new_hand,
)
from . import config
from .encoding import CARD_END, N_FEATURES, card_features, features
from .mccfr import street_raises
from .model import NumpyNet
from .solver import (
    COMBO_CARDS, Decision, N_COMBOS, SolveSettings, Solution, _avg_sigma, combo_index, solve,
    valid_mask,
)

_FRACTIONS = config.RAISE_FRACTIONS
_MAX_RAISES = config.MAX_RAISES_PER_STREET

#: プリフロップの葉（そのままショーダウン）で平均するランアウトの見本の数。
#: 1 回だけ作って使い回す（7 秒ほど）
PREFLOP_RUNOUTS = 1500


def default_settings() -> dict[int, SolveSettings]:
    """ストリートごとの解き方（既定 = 深く読む）。

    - ターン: リバーのカード 48 通りそれぞれについてリバーの賭けまで組む（1 手 4 秒ほど）
    - フロップ: ターンのカードを 12 枚見本で取り、それぞれターンの賭けまで組む（リバーは
      見本 16 枚のショーダウン。1 手 6 秒ほど）
    - リバー: そのまま解く（1 秒ほど）
    """
    return {
        PREFLOP: SolveSettings(iterations=150, flop_runouts=PREFLOP_RUNOUTS),
        FLOP: SolveSettings(iterations=60, flop_runouts=100, flop_turns=12, leaf_rivers=16),
        TURN: SolveSettings(iterations=60, turn_rivers=48),
        RIVER: SolveSettings(iterations=150),
    }


def quick_settings() -> dict[int, SolveSettings]:
    """速い版（1 手 1〜2 秒）。ターンとフロップは「そのままショーダウン」で打ち切る（深さ制限）。"""
    return {
        PREFLOP: SolveSettings(iterations=150, flop_runouts=PREFLOP_RUNOUTS),
        FLOP: SolveSettings(iterations=120, flop_runouts=100),
        TURN: SolveSettings(iterations=120),
        RIVER: SolveSettings(iterations=150),
    }


def fast_settings() -> dict[int, SolveSettings]:
    """テスト用（粗いが速い）。"""
    return {
        PREFLOP: SolveSettings(iterations=20, flop_runouts=60),
        FLOP: SolveSettings(iterations=20, flop_runouts=20),
        TURN: SolveSettings(iterations=20),
        RIVER: SolveSettings(iterations=20),
    }


# ---- ネットで「相手がこう打つ確率」を 1326 通りまとめて出す ----


def _batch(net: NumpyNet, x: np.ndarray) -> np.ndarray:
    h = x
    last = len(net.layers) - 1
    for i, (w, b) in enumerate(net.layers):
        h = h @ w + b
        if i != last:
            np.maximum(h, 0.0, out=h)
    return h


def _masked_softmax_rows(logits: np.ndarray, mask: list[bool]) -> np.ndarray:
    m = np.array(mask, dtype=bool)
    z = np.where(m[None, :], logits, -np.inf)
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


@lru_cache(maxsize=32)
def card_parts(board: tuple[int, ...]) -> np.ndarray:
    """このボードでの、全コンボぶんのカード由来の特徴量 (n, F)。かぶるコンボは 0 のまま。

    賭けの進み方によらず同じなので、ボードごとに 1 回作って使い回す。
    """
    street = BOARD_COUNT.index(len(board))
    filler = [c for c in range(52) if c not in board]
    full = tuple(board) + tuple(filler[:5 - len(board)])
    out = np.zeros((N_COMBOS, N_FEATURES), dtype=np.float32)
    for i in np.nonzero(valid_mask(board))[0]:
        hole = (int(COMBO_CARDS[i, 0]), int(COMBO_CARDS[i, 1]))
        st = new_hand((hole, (filler[-1], filler[-2])), full, start_stack=200, button=0)
        out[i] = card_features(st._with(street=street), 0)
    return out


def model_probs(net: NumpyNet, s: State, p: int, prefix: str, epsilon: float) -> np.ndarray:
    """`s` で `p` が各手を選ぶ確率を、`p` の手札 1326 通りぶん (n, A) で返す（ネットのモデル）。

    `epsilon` の割合で「どの手も打ちうる」を混ぜる（0 になるのを防ぐ）。
    """
    mask = legal_mask(s, _FRACTIONS, _MAX_RAISES, street_raises(prefix))
    n_legal = sum(mask)
    if not net.weights:
        return np.full((N_COMBOS, len(mask)), 1.0 / n_legal, dtype=np.float32) * np.array(mask)
    x = card_parts(tuple(s.board)).copy()
    x[:, CARD_END:] = features(s, p, prefix)[CARD_END:]
    probs = _masked_softmax_rows(_batch(net, x), mask)
    return (1.0 - epsilon) * probs + epsilon / n_legal * np.array(mask, dtype=np.float32)


# ---- 履歴の復元 ----


def replay(st: State, hist: str) -> tuple[list[tuple[State, int, int, str]], State]:
    """履歴の文字列から、各手の (打つ前の局面, 打った人, 枠の番号, そこまでの履歴) と最後の局面を復元する。

    人の任意額のレイズは枠に読み替えられているので、復元した局面のポットは実物と少し
    違うことがある。レンジの計算にはそれで十分（ネットも枠しか見ていない）。
    """
    s = new_hand(st.holes, st.full_board, start_stack=st.start_stack, button=st.button)
    out = []
    prefix = ""
    raises = 0
    for ch in hist:
        if ch == "/":
            prefix += "/"
            continue
        idx = int(ch)
        mask = legal_mask(s, _FRACTIONS, _MAX_RAISES, raises)
        if not mask[idx]:  # 読み替えの誤差で打てなくなっていたら、一番近い枠に寄せる
            legal = [i for i, ok in enumerate(mask) if ok]
            idx = min(legal, key=lambda i: abs(i - idx))
        out.append((s, s.to_act, idx, prefix))
        nxt = apply_action(s, action_from_index(s, idx, _FRACTIONS))
        raises = 0 if nxt.street != s.street else raises + (1 if idx >= 2 else 0)
        prefix += str(idx)  # ストリートの区切り "/" は履歴の文字列そのものに入っている
        s = nxt
        if s.finished:
            break
    return out, s


# ---- プリフロップは解いた結果を使い回す ----

_preflop_cache: dict[tuple, Solution] = {}


def preflop_solution(net: NumpyNet, stack: int, button: int, hist: str, epsilon: float,
                     settings: SolveSettings) -> Solution:
    """プリフロップの局面（スタック・ボタン・履歴で決まる）を解いた結果。同じ局面は 1 回だけ解く。

    レンジは「自分の行動は前の局面を解いた平均戦略、相手の行動はネット」で作る
    （`SearchPlayer` が持ち歩くレンジと同じ作り方）。手札のかぶりは無視する（使い回すため）。
    """
    key = (id(net), stack, button, hist, epsilon, settings.iterations, settings.flop_runouts)
    hit = _preflop_cache.get(key)
    if hit is not None:
        return hit
    dummy = new_hand(((0, 1), (2, 3)), (4, 5, 6, 7, 8), start_stack=stack, button=button)
    steps, final = replay(dummy, hist)
    actor = final.to_act
    r = [np.ones(N_COMBOS, dtype=np.float32), np.ones(N_COMBOS, dtype=np.float32)]
    for s, p, idx, prefix in steps:
        if p == actor:
            prev = preflop_solution(net, stack, button, prefix, epsilon, settings)
            r[p] *= prev.range_strategy()[prev.root.actions.index(idx)]
        else:
            r[p] *= model_probs(net, s, p, prefix, epsilon)[:, idx]
    sol = solve(final, actor, (r[0], r[1]), street_raises(hist), settings)
    if len(_preflop_cache) > 512:
        _preflop_cache.clear()
    _preflop_cache[key] = sol
    return sol


# ---- プレイヤー ----


def hand_key(st: State) -> tuple:
    return (st.holes, st.full_board, st.start_stack, st.button)


class SearchPlayer:
    """レンジを持ち歩きながら、その場で解いて打つ。呼び方は `PolicyFn` と同じ。"""

    def __init__(self, net: NumpyNet, seed: int = 0, epsilon: float = 0.05,
                 settings: dict[int, SolveSettings] | None = None, net_weight: float = 0.5):
        self.net = net
        self.rng = random.Random(seed)
        self.epsilon = epsilon
        self.net_weight = net_weight  # 相手のモデルのうちネットの割合（残りはソルバーの均衡戦略）
        self.settings = settings or default_settings()
        self.memo: dict | None = None
        self.last_probs: list[float] | None = None
        self.last_solution: Solution | None = None

    # -- レンジの持ち越し（API はリクエストをまたぐので JSON にして保存する） --

    def dump_memo(self) -> dict | None:
        if self.memo is None:
            return None
        holes, board, stack, button = self.memo["key"]
        return {
            "holes": [list(holes[0]), list(holes[1])],
            "board": list(board),
            "stack": stack,
            "button": button,
            "n": self.memo["n"],
            "ranges": [np.round(r, 6).tolist() for r in self.memo["ranges"]],
            "eq": None if self.memo.get("eq") is None else {
                "prefix": self.memo["eq"]["prefix"],
                "actions": list(self.memo["eq"]["actions"]),
                "probs": np.round(self.memo["eq"]["probs"], 4).tolist(),
            },
        }

    def load_memo(self, memo: dict | None) -> None:
        if not memo:
            self.memo = None
            return
        key = (((memo["holes"][0][0], memo["holes"][0][1]), (memo["holes"][1][0], memo["holes"][1][1])),
               tuple(memo["board"]), memo["stack"], memo["button"])
        eq = memo.get("eq")
        self.memo = {
            "key": key,
            "n": int(memo["n"]),
            "ranges": [np.array(r, dtype=np.float32) for r in memo["ranges"]],
            "eq": None if eq is None else {
                "prefix": eq["prefix"],
                "actions": list(eq["actions"]),
                "probs": np.array(eq["probs"], dtype=np.float32),
            },
        }

    # -- 手を選ぶ --

    def _equilibrium(self, s: State, idx: int, prefix: str) -> np.ndarray | None:
        """`s` で `idx` を打つ確率の、ソルバーの均衡戦略（1326 通り）。無ければ None。"""
        if s.street == PREFLOP:
            sol = preflop_solution(self.net, s.start_stack, s.button, prefix, self.epsilon,
                                   self.settings[PREFLOP])
            if idx in sol.root.actions:
                return sol.range_strategy()[sol.root.actions.index(idx)]
            return None
        eq = self.memo.get("eq")
        if eq is not None and eq["prefix"] == prefix and idx in eq["actions"]:
            return eq["probs"][eq["actions"].index(idx)]
        return None

    def _advance(self, st: State, player: int, hist: str) -> None:
        """前回から進んだぶんの行動（相手のもの）をレンジに掛ける。"""
        key = hand_key(st)
        if self.memo is None or self.memo["key"] != key:
            self.memo = {"key": key, "n": 0, "eq": None,
                         "ranges": [np.ones(N_COMBOS, dtype=np.float32),
                                    np.ones(N_COMBOS, dtype=np.float32)]}
        steps, _ = replay(st, hist)
        for s, p, idx, prefix in steps[self.memo["n"]:]:
            # 自分の行動がここに来るのは、レンジの持ち越しが失われたとき（サーバーの再起動など）。
            # そのときは自分も相手と同じモデルで代用する
            w = model_probs(self.net, s, p, prefix, self.epsilon)[:, idx]
            eq = self._equilibrium(s, idx, prefix)
            if eq is not None:
                w = self.net_weight * w + (1.0 - self.net_weight) * eq
            self.memo["ranges"][p] *= w
        self.memo["n"] = len(steps)

    def __call__(self, st: State, player: int, hist: str) -> int:
        mask = legal_mask(st, _FRACTIONS, _MAX_RAISES, street_raises(hist))
        self._advance(st, player, hist)
        opp = 1 - player
        ranges = [None, None]
        ranges[player] = self.memo["ranges"][player] * valid_mask(st.board)
        ranges[opp] = (self.memo["ranges"][opp] * valid_mask(st.board)
                       * valid_mask(st.holes[player]))
        if st.street == PREFLOP:
            sol = preflop_solution(self.net, st.start_stack, st.button, hist, self.epsilon,
                                   self.settings[PREFLOP])
        else:
            sol = solve(st, player, (ranges[0], ranges[1]), street_raises(hist),
                        self.settings[st.street])
        self.last_solution = sol
        mix = sol.strategy(combo_index(st.holes[player]))
        probs = [mix.get(i, 0.0) if mask[i] else 0.0 for i in range(len(mask))]
        self.last_probs = list(probs)
        chosen = self._sample(probs, mask)
        # 自分のレンジは、自分の平均戦略で更新する（相手から見た「自分の持ちうる手」）
        pos = sol.root.actions.index(chosen)
        self.memo["ranges"][player] *= sol.range_strategy()[pos]
        self.memo["n"] += 1
        # この手に対する相手の応手（均衡戦略）を覚えておき、次に相手のレンジを更新するときに混ぜる
        child = sol.root.children[pos]
        self.memo["eq"] = None
        if isinstance(child, Decision) and child.player == opp:
            self.memo["eq"] = {"prefix": hist + str(chosen), "actions": list(child.actions),
                               "probs": _avg_sigma(child)[:, 0, :].astype(np.float32)}
        return chosen

    def _sample(self, probs: list[float], mask: list[bool]) -> int:
        roll = self.rng.random() * sum(probs)
        acc = 0.0
        for i, p in enumerate(probs):
            acc += p
            if roll < acc and mask[i]:
                return i
        return max(range(len(probs)), key=lambda i: probs[i] if mask[i] else -1.0)


def search_player(net: NumpyNet, seed: int = 0, epsilon: float = 0.05,
                  settings: dict[int, SolveSettings] | None = None,
                  net_weight: float = 0.5) -> SearchPlayer:
    """`players.neural_player` と同じ呼び方で作る。"""
    return SearchPlayer(net, seed=seed, epsilon=epsilon, settings=settings, net_weight=net_weight)
