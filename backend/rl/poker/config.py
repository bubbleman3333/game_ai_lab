"""ポーカーの学習の設定。

**ここを変えると学習した戦略は使えなくなる**ので、`ABSTRACTION_VERSION` を上げること
（テトリスの `FEATURE_VERSION`、オセロの `PATTERN_VERSION` と同じ扱い）。

ノーリミットのゲーム木はそのままでは大きすぎる（ベット額が連続で、局面が 10^160 通り）。
そこで 2 つの向きに「まとめる」。

1. **ベット額をまとめる**（`RAISE_FRACTIONS`）: ポットに対する倍率とオールインだけにする。
   人間が打った中途半端な額は `games.poker.translate()` で一番近い枠に読み替える。
2. **手札とボードをまとめる**（`abstraction.py`）: 強さの近い手を同じ「バケツ」に入れる。

まとめ方を細かくすると強くなるが、学習に必要な対局数も増える。
"""

from __future__ import annotations

from games.poker.rules import RAISE_FRACTIONS as GAME_RAISE_FRACTIONS

ABSTRACTION_VERSION = 1

# ---- ベット額のまとめ方 ----
# ベット額の枠は games/poker/rules.py に 1 つだけ置く（2 か所に持つとずれる）
RAISE_FRACTIONS = GAME_RAISE_FRACTIONS
# 1 ストリートあたりのレイズの回数の上限。木の大きさを抑えるため（実戦でもここまで行くのは稀）
MAX_RAISES_PER_STREET = 2

# ---- 手札のまとめ方 ----
# プリフロップは 169 通り（AKs・AKo …）をそのまま使う。まとめない
PREFLOP_BUCKETS = 169
# フロップ以降は「このボードで相手が持ちうる手のうち何 % に勝っているか」を何段階に分けるか
STRENGTH_BUCKETS = 8
# 強さのほかに「フラッシュを引きかけ」「ストレートを引きかけ」の 2 つを別扱いにする
DRAW_KINDS = 4
POSTFLOP_BUCKETS = STRENGTH_BUCKETS * DRAW_KINDS

# 強さは「このボードで相手が持ちうる手」の見本と比べて測る。見本の数と乱数の種。
# 種はボードから決まるので、同じ局面はいつでも同じバケツになる（あとから戦略がずれない）
PROBE_COUNT = 24
PROBE_SEED = 20240915

# ---- スタックの深さ ----
# **同じ手札でもスタックが浅いと打ち方は全く変わる**（浅いほど降りるか突っ込むかになる）。
# 深さごとに別の戦略を学ぶ。ビッグブラインド何個分か
STACK_DEPTHS_BB = (20, 50, 100)

# ---- 学習 ----
DEFAULT_TRAVERSALS = 2_000_000  # 既定の学習量（1 回 = 1 局ぶんの木をたどる）
EVAL_EVERY = 100_000
EVAL_HANDS = 20_000  # 評価の対局数


def action_fractions() -> tuple[float, ...]:
    return RAISE_FRACTIONS


def depth_bucket(start_stack: int, big_blind: int = 2) -> int:
    """開始スタックを、学習した深さのうち一番近いものに割り当てる。"""
    bb = start_stack / big_blind
    best, diff = 0, None
    for i, depth in enumerate(STACK_DEPTHS_BB):
        d = abs(depth - bb)
        if diff is None or d < diff:
            best, diff = i, d
    return best


def config_dict() -> dict:
    return {
        "abstraction_version": ABSTRACTION_VERSION,
        "raise_fractions": list(RAISE_FRACTIONS),
        "max_raises_per_street": MAX_RAISES_PER_STREET,
        "preflop_buckets": PREFLOP_BUCKETS,
        "strength_buckets": STRENGTH_BUCKETS,
        "draw_kinds": DRAW_KINDS,
        "stack_depths_bb": list(STACK_DEPTHS_BB),
    }
