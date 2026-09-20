"""ヘッズアップ（1 対 1）ノーリミット・テキサスホールデムの進行ルール。

純粋な Python で、Django にも numpy にも依存しない。時間やアニメーションは扱わない。

- プレイヤーは 0 と 1 の 2 人。`button` がボタン（＝スモールブラインド）。
- プリフロップはボタンから、フロップ以降はボタンでない側から行動する（ヘッズアップの決まり）。
- ベット額に上限はない（ノーリミット）。ただし**AI が選ぶ手はポットに対する倍率で離散化**する。
  離散化した手は `ACTION_COUNT` 個の固定の枠に入るので、ニューラルネットの出力にそのまま使える。
  人間が任意の額をベットしたときは `translate()` で一番近い枠に読み替える。

`State` は全部の情報（相手のホールカードと未公開のボード）を持つ。**プレイヤーに見せる情報は
`state.board` と自分のホールカードだけ**で、これは CFR の「情報集合」を作るときに使う。

TypeScript 版は frontend/src/games/poker/engine/rules.ts。変えたら両方直し、
`python -m games.poker.fixtures` でテストデータを作り直すこと。
"""

from __future__ import annotations

from dataclasses import dataclass

from .cards import cards_str, hand_value

PREFLOP, FLOP, TURN, RIVER = 0, 1, 2, 3
STREET_NAMES = ("プリフロップ", "フロップ", "ターン", "リバー")
BOARD_COUNT = (0, 3, 4, 5)

SMALL_BLIND = 1
BIG_BLIND = 2
DEFAULT_STACK = 200  # 100BB

# 手の種類
FOLD = 0
CHECK = 1
CALL = 2
RAISE = 3
KIND_NAMES = ("フォールド", "チェック", "コール", "レイズ")

# レイズ額の離散化（コールした後のポットに対する倍率）。最後に必ずオールインが付く。
# **ここが AI の手の枠の数を決める唯一の場所**。rl/poker/config.py もこれを読む
# （2 つ持つと「学習は 2 種類・画面は 3 種類」のようにずれて、学習していない手を打たせてしまう）。
# 倍率を 1 つ増やすと情報集合が約 1.8 倍になり、同じ学習時間での詰め方が甘くなる。
# 人間は任意の額を賭けられる（`translate()` が一番近い枠に読み替える）ので、
# 枠を増やさなくてもノーリミットらしさは失われない。
RAISE_FRACTIONS = (0.5, 1.0)

# 手の枠（ニューラルネットの出力の並び）: 0=フォールド, 1=チェック/コール, 2..=倍率レイズ, 最後=オールイン
IDX_FOLD = 0
IDX_CHECK_CALL = 1
IDX_RAISE_BASE = 2


def action_count(fractions: tuple[float, ...] = RAISE_FRACTIONS) -> int:
    return IDX_RAISE_BASE + len(fractions) + 1


ACTION_COUNT = action_count()
IDX_ALL_IN = ACTION_COUNT - 1


@dataclass(frozen=True)
class Action:
    """打つ手。`to` は「このストリートで自分が出す合計額」（レイズとコールで使う）。"""

    kind: int
    to: int = 0
    index: int = -1  # 離散化した枠の番号（枠に対応しない任意額のときは -1）

    def __str__(self) -> str:
        if self.kind == RAISE:
            return "レイズ to " + str(self.to)
        return KIND_NAMES[self.kind]


@dataclass(frozen=True, slots=True)
class State:
    """1 局の途中の状態。すべての情報を持つ（見せる情報は別に作る）。

    学習で 1 秒に何万個も作るので `slots=True` にし、書き換えの多いところでは
    `dataclasses.replace()` ではなく `_with()` で作る（replace は毎回すべての項目を
    getattr で読み直すので、実測で全体の 1 割以上を食っていた）。
    """

    holes: tuple[tuple[int, int], tuple[int, int]]
    full_board: tuple[int, ...]  # 5 枚。street の分だけ表に出る
    street: int = PREFLOP
    committed: tuple[int, int] = (0, 0)  # この局で出した合計
    street_bet: tuple[int, int] = (0, 0)  # このストリートで出した額
    to_act: int = 0
    acted: tuple[bool, bool] = (False, False)  # このストリートで行動したか（ブラインドは含めない）
    last_raise: int = BIG_BLIND  # 直前のレイズ幅（最低レイズ幅の計算に使う）
    folded: int = -1  # 降りた人。-1 = なし
    start_stack: int = DEFAULT_STACK
    button: int = 0
    finished: bool = False

    @property
    def board(self) -> tuple[int, ...]:
        """今の時点で表に出ているボード。"""
        return self.full_board[:BOARD_COUNT[self.street]]

    @property
    def pot(self) -> int:
        return self.committed[0] + self.committed[1]

    def stack_left(self, p: int) -> int:
        return self.start_stack - self.committed[p]

    def is_all_in(self, p: int) -> bool:
        return self.stack_left(p) == 0

    def _with(self, **kw) -> "State":
        """項目を差し替えた新しい状態。`dataclasses.replace()` の速い版。"""
        return State(
            holes=kw.get("holes", self.holes),
            full_board=kw.get("full_board", self.full_board),
            street=kw.get("street", self.street),
            committed=kw.get("committed", self.committed),
            street_bet=kw.get("street_bet", self.street_bet),
            to_act=kw.get("to_act", self.to_act),
            acted=kw.get("acted", self.acted),
            last_raise=kw.get("last_raise", self.last_raise),
            folded=kw.get("folded", self.folded),
            start_stack=kw.get("start_stack", self.start_stack),
            button=kw.get("button", self.button),
            finished=kw.get("finished", self.finished),
        )


def new_hand(
    holes: tuple[tuple[int, int], tuple[int, int]],
    full_board: tuple[int, ...],
    start_stack: int = DEFAULT_STACK,
    button: int = 0,
) -> State:
    """ブラインドを出した状態から始める。"""
    if start_stack < BIG_BLIND * 2:
        raise ValueError("スタックが小さすぎる（ビッグブラインドの 2 倍以上にする）")
    sb, bb = button, 1 - button
    posted = [0, 0]
    posted[sb] = min(SMALL_BLIND, start_stack)
    posted[bb] = min(BIG_BLIND, start_stack)
    return State(
        holes=holes,
        full_board=tuple(full_board),
        street=PREFLOP,
        committed=(posted[0], posted[1]),
        street_bet=(posted[0], posted[1]),
        to_act=sb,  # プリフロップはボタン（SB）から
        acted=(False, False),
        last_raise=BIG_BLIND,
        start_stack=start_stack,
        button=button,
    )


def to_call(st: State, p: int | None = None) -> int:
    """あと何チップ足せばコールになるか（相手より持ちが少なければその分まで）。"""
    p = st.to_act if p is None else p
    need = st.street_bet[1 - p] - st.street_bet[p]
    return max(0, min(need, st.stack_left(p)))


def max_raise_to(st: State, p: int | None = None) -> int:
    """オールインしたときの `to`。"""
    p = st.to_act if p is None else p
    return st.street_bet[p] + st.stack_left(p)


def min_raise_to(st: State, p: int | None = None) -> int:
    """最低レイズの `to`（相手のベット + 直前のレイズ幅。足りなければオールイン）。"""
    p = st.to_act if p is None else p
    want = st.street_bet[1 - p] + max(st.last_raise, BIG_BLIND)
    return min(want, max_raise_to(st, p))


def can_raise(st: State, p: int | None = None) -> bool:
    p = st.to_act if p is None else p
    o = 1 - p
    # 相手がオールインならレイズしても意味がないので、コールかフォールドだけ
    return not st.finished and st.stack_left(p) > to_call(st, p) and st.stack_left(o) > 0


def raise_to_for_fraction(st: State, frac: float) -> int:
    """「コールした後のポットの frac 倍」を上乗せするレイズの `to`。"""
    p = st.to_act
    call = to_call(st, p)
    pot_after_call = st.pot + call
    want = st.street_bet[p] + call + int(round(frac * pot_after_call))
    return max(min_raise_to(st, p), min(want, max_raise_to(st, p)))


def legal_mask(
    st: State,
    fractions: tuple[float, ...] = RAISE_FRACTIONS,
    max_raises: int | None = None,
    raises_so_far: int = 0,
) -> list[bool]:
    """離散化した枠ごとに、打てるかどうか。同じ額になる枠は 1 つだけ残す。"""
    n = action_count(fractions)
    mask = [False] * n
    if st.finished:
        return mask
    p = st.to_act
    call = to_call(st, p)
    mask[IDX_FOLD] = call > 0
    mask[IDX_CHECK_CALL] = True  # コールもチェックもこの枠
    if can_raise(st, p) and (max_raises is None or raises_so_far < max_raises):
        all_in = max_raise_to(st, p)
        mask[n - 1] = True
        seen = {all_in}
        for i, frac in enumerate(fractions):
            amount = raise_to_for_fraction(st, frac)
            if amount in seen:
                continue  # オールインや他の倍率と同じ額になる枠は使わない
            seen.add(amount)
            mask[IDX_RAISE_BASE + i] = True
    return mask


def action_from_index(st: State, index: int, fractions: tuple[float, ...] = RAISE_FRACTIONS) -> Action:
    """枠の番号を実際の手に直す。"""
    n = action_count(fractions)
    p = st.to_act
    if index == IDX_FOLD:
        return Action(FOLD, index=index)
    if index == IDX_CHECK_CALL:
        call = to_call(st, p)
        if call == 0:
            return Action(CHECK, to=st.street_bet[p], index=index)
        return Action(CALL, to=st.street_bet[p] + call, index=index)
    if index == n - 1:
        return Action(RAISE, to=max_raise_to(st, p), index=index)
    frac = fractions[index - IDX_RAISE_BASE]
    return Action(RAISE, to=raise_to_for_fraction(st, frac), index=index)


def legal_actions(
    st: State,
    fractions: tuple[float, ...] = RAISE_FRACTIONS,
    max_raises: int | None = None,
    raises_so_far: int = 0,
) -> list[Action]:
    mask = legal_mask(st, fractions, max_raises, raises_so_far)
    return [action_from_index(st, i, fractions) for i, ok in enumerate(mask) if ok]


def translate(st: State, kind: int, to: int = 0, fractions: tuple[float, ...] = RAISE_FRACTIONS) -> int:
    """人間が打った任意額の手を、一番近い枠の番号に読み替える（AI に渡すため）。"""
    if kind == FOLD:
        return IDX_FOLD
    if kind in (CHECK, CALL):
        return IDX_CHECK_CALL
    mask = legal_mask(st, fractions)
    best, best_diff = IDX_CHECK_CALL, None
    for i, ok in enumerate(mask):
        if not ok or i < IDX_RAISE_BASE:
            continue
        diff = abs(action_from_index(st, i, fractions).to - to)
        if best_diff is None or diff < best_diff:
            best, best_diff = i, diff
    return best


def apply_action(st: State, action: Action) -> State:
    """手を打った後の状態を返す（元の状態は変えない）。"""
    if st.finished:
        raise ValueError("もう終わっている局に手を打とうとした")
    p = st.to_act
    o = 1 - p
    committed = list(st.committed)
    street_bet = list(st.street_bet)
    acted = [st.acted[0], st.acted[1]]
    last_raise = st.last_raise

    if action.kind == FOLD:
        if to_call(st, p) == 0:
            raise ValueError("コールが要らないのにフォールドしようとした")
        return st._with(folded=p, finished=True, acted=(True, True))

    if action.kind == CHECK:
        if to_call(st, p) != 0:
            raise ValueError("コールが要るのにチェックしようとした")
        acted[p] = True
    elif action.kind == CALL:
        call = to_call(st, p)
        if call == 0:
            raise ValueError("コールが要らないのにコールしようとした")
        committed[p] += call
        street_bet[p] += call
        acted[p] = True
    elif action.kind == RAISE:
        lo, hi = min_raise_to(st, p), max_raise_to(st, p)
        if not can_raise(st, p):
            raise ValueError("レイズできない場面でレイズしようとした")
        if action.to < lo or action.to > hi:
            raise ValueError("レイズ額が範囲外: " + str(action.to))
        last_raise = action.to - street_bet[o]
        committed[p] += action.to - street_bet[p]
        street_bet[p] = action.to
        acted[p] = True
        acted[o] = False  # 相手はもう一度行動する
    else:
        raise ValueError("知らない手の種類: " + str(action.kind))

    nxt = st._with(
        committed=(committed[0], committed[1]),
        street_bet=(street_bet[0], street_bet[1]),
        acted=(acted[0], acted[1]),
        last_raise=last_raise,
        to_act=o,
    )

    both_acted = nxt.acted[0] and nxt.acted[1]
    matched = nxt.street_bet[0] == nxt.street_bet[1]
    someone_all_in = nxt.is_all_in(0) or nxt.is_all_in(1)
    if both_acted and (matched or someone_all_in):
        return _next_street(nxt)
    if nxt.is_all_in(o):
        # 相手はもう出せるチップがないので行動できない。手番を戻さず先へ進める
        return _next_street(nxt)
    return nxt


def _next_street(st: State) -> State:
    """ベットが揃った。次のストリートへ進めるか、終局にする。"""
    if st.is_all_in(0) or st.is_all_in(1):
        # どちらかが出し切っているので、残りのボードを配ってショーダウン
        return st._with(street=RIVER, finished=True)
    if st.street == RIVER:
        return st._with(finished=True)
    return st._with(
        street=st.street + 1,
        street_bet=(0, 0),
        acted=(False, False),
        last_raise=BIG_BLIND,
        to_act=1 - st.button,  # フロップ以降はボタンでない側から
    )


def showdown_winner(st: State) -> int:
    """ショーダウンの勝者。-1 = 引き分け。"""
    v0 = hand_value(tuple(st.holes[0]) + st.full_board)
    v1 = hand_value(tuple(st.holes[1]) + st.full_board)
    if v0 == v1:
        return -1
    return 0 if v0 > v1 else 1


def payoff(st: State) -> tuple[int, int]:
    """終局した局の収支（チップ）。合計は必ず 0 になる。

    出した額が違うときは、多い方の余りは戻る（少ない方の額までしか勝負にならない）。
    """
    if not st.finished:
        raise ValueError("まだ終わっていない局の収支を求めようとした")
    stake = min(st.committed)
    if st.folded >= 0:
        winner = 1 - st.folded
    else:
        winner = showdown_winner(st)
    if winner < 0:
        return (0, 0)
    return (stake, -stake) if winner == 0 else (-stake, stake)


def advance_history(st: State, child: State, index: int, hist: str) -> str:
    """打った手を履歴の文字列に足す（ストリートが変わったら "/" で区切る）。

    この文字列が AI の「情報集合」の鍵になる。**AI から見えてよい情報だけ**でできている
    （誰が何をしたかの並びだけで、カードは入らない）。
    """
    if child.finished:
        return hist + str(index)
    return hist + str(index) + ("/" if child.street != st.street else "")


def describe(st: State) -> str:
    """ログや調査のための 1 行表示。"""
    who = "終局" if st.finished else "P" + str(st.to_act) + "の手番"
    return (
        "[" + STREET_NAMES[st.street] + "] board=" + (cards_str(st.board) or "-")
        + " pot=" + str(st.pot)
        + " bet=" + str(st.street_bet)
        + " 残り=" + str((st.stack_left(0), st.stack_left(1)))
        + " " + who
    )
