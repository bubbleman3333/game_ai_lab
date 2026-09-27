"""強さの測り方。

ポーカーは運の幅が大きく、素朴に対戦させると「1 万局やっても、どちらが強いか分からない」
ことがざらにある。そこで**同じカードを配って席を入れ替えて 2 回打つ**（ミラー方式）。
カードの運が打ち消し合うので、同じ局数でずっと細かく差が見える。

単位は **mbb/hand**（1 局あたり、ビッグブラインドの 1/1000 が何個か）。ポーカーの世界で
よく使われる単位で、+50 mbb/hand ならかなり勝っている。

それでもブレは残るので、**標準誤差（`stderr_mbb`）も一緒に返す**。実際、同じ戦略が
4000 局の評価で +392、24000 局で -165 になったことがあり、局数をケチると
「一番よい重み」の選択がほぼ運になる。差が標準誤差の 2 倍より小さければ、まだ何も言えない。

「簡単に退場しないか」は別に測る（`survival`）。スタックを持ち越して片方が飛ぶまで打ち、
自分が飛んだ割合と、何局もったかを見る。
"""

from __future__ import annotations

from dataclasses import dataclass

from games.poker.cards import Rng
from games.poker.game import PolicyFn, deal, play_hand, play_match
from games.poker.rules import BIG_BLIND
from . import config


@dataclass
class HeadToHead:
    """1 対 1 の結果（すべて「a から見て」）。"""

    hands: int
    chips: int
    mbb_per_hand: float
    win_rate: float  # 引き分けを 0.5 として数えた勝率
    stderr_mbb: float = 0.0  # mbb/hand の標準誤差
    # 別プロセスの結果を合算するための元の数（同じカードで 2 回打った合計の和と二乗和）
    pairs: int = 0
    pair_sum: float = 0.0
    pair_sq: float = 0.0
    wins: float = 0.0

    def as_dict(self) -> dict:
        return {
            "hands": self.hands,
            "chips": self.chips,
            "mbb_per_hand": round(self.mbb_per_hand, 1),
            "stderr_mbb": round(self.stderr_mbb, 1),
            "win_rate": round(self.win_rate, 4),
        }

    def __str__(self) -> str:
        return f"{self.mbb_per_hand:+.1f} ± {self.stderr_mbb:.1f} mbb/hand（{self.hands:,} 局）"


def head_to_head(
    a: PolicyFn,
    b: PolicyFn,
    hands: int = 20_000,
    seed: int = 1,
    start_stack: int = 200,
) -> HeadToHead:
    """同じカードで席を入れ替えて 2 回ずつ打つ（ミラー方式）。`hands` は合計の局数。"""
    rng = Rng(seed)
    pairs = max(1, hands // 2)
    chips = 0
    wins = 0.0
    played = 0
    # 「同じカードで 2 回打った合計」を 1 つの標本として散らばりを測る（ここがブレの単位）
    pair_sum = 0.0
    pair_sq = 0.0
    for i in range(pairs):
        state = deal(rng, start_stack=start_stack, button=i % 2)
        gain_pair = 0
        for seat in (0, 1):
            policies = (a, b) if seat == 0 else (b, a)
            result = play_hand(state, policies, config.RAISE_FRACTIONS,
                               config.MAX_RAISES_PER_STREET)
            gain = result.payoff[seat]
            gain_pair += gain
            chips += gain
            wins += 1.0 if gain > 0 else (0.5 if gain == 0 else 0.0)
            played += 1
        pair_sum += gain_pair
        pair_sq += gain_pair * gain_pair
    return _from_stats(pairs, played, chips, wins, pair_sum, pair_sq)


def _from_stats(pairs: int, played: int, chips: int, wins: float, pair_sum: float,
                pair_sq: float) -> HeadToHead:
    mean_pair = pair_sum / pairs
    var_pair = max(0.0, pair_sq / pairs - mean_pair * mean_pair)
    # 1 局あたりに直すので 2 で割り、標本数の平方根で割る
    stderr = (var_pair / pairs) ** 0.5 / 2 / BIG_BLIND * 1000 if pairs > 1 else 0.0
    return HeadToHead(
        hands=played,
        chips=chips,
        mbb_per_hand=chips / played / BIG_BLIND * 1000,
        win_rate=wins / played,
        stderr_mbb=stderr,
        pairs=pairs, pair_sum=pair_sum, pair_sq=pair_sq, wins=wins,
    )


def merge(results: list[HeadToHead]) -> HeadToHead:
    """別々に測った結果（同じ組み合わせ）を 1 つにまとめる。"""
    return _from_stats(
        pairs=sum(r.pairs for r in results),
        played=sum(r.hands for r in results),
        chips=sum(r.chips for r in results),
        wins=sum(r.wins for r in results),
        pair_sum=sum(r.pair_sum for r in results),
        pair_sq=sum(r.pair_sq for r in results),
    )


def _h2h_worker(args) -> HeadToHead:
    spec_a, spec_b, hands, seed, start_stack = args
    try:
        import torch

        torch.set_num_threads(1)
    except ImportError:
        pass
    from .exploit import _load_policy

    return head_to_head(_load_policy(spec_a, seed=seed), _load_policy(spec_b, seed=seed + 1),
                        hands=hands, seed=seed, start_stack=start_stack)


def head_to_head_parallel(spec_a: str, spec_b: str, hands: int, workers: int, seed: int = 1,
                          start_stack: int = 200) -> HeadToHead:
    """AI の ID どうしを複数プロセスで対戦させる（その場で解く AI は 1 手 1〜2 秒かかるため）。"""
    import multiprocessing as mp
    import os

    # 子プロセスの BLAS を 1 スレッドにする（14 プロセス × 16 スレッドだと取り合いで 20 倍遅くなった）。
    # Windows は子を新しく起動するので、親の環境変数がそのまま効く
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[var] = "1"
    workers = max(1, workers)
    # numba（ソルバーの下の木）はプロセスの中でも並列に回るので、コアを分け合う
    os.environ["NUMBA_NUM_THREADS"] = str(max(1, (os.cpu_count() or 8) // workers))
    chunk = max(2, hands // workers)
    args = [(spec_a, spec_b, chunk, seed * 1000 + i, start_stack) for i in range(workers)]
    if workers == 1:
        return _h2h_worker(args[0])
    with mp.Pool(workers) as pool:
        return merge(pool.map(_h2h_worker, args))


@dataclass
class Survival:
    """退場のしにくさ（すべて「a から見て」）。"""

    matches: int
    busted: int  # a が飛んだ回数
    survived: int  # 上限の局数まで生き残った回数
    avg_hands: float

    @property
    def bust_rate(self) -> float:
        return self.busted / self.matches

    def as_dict(self) -> dict:
        return {
            "matches": self.matches,
            "busted": self.busted,
            "survived": self.survived,
            "bust_rate": round(self.bust_rate, 4),
            "avg_hands": round(self.avg_hands, 1),
        }


def survival(
    a: PolicyFn,
    b: PolicyFn,
    matches: int = 200,
    start_stack: int = 200,
    max_hands: int = 500,
    seed: int = 1,
) -> Survival:
    """スタックを持ち越して、片方が飛ぶまで打つのを何度も繰り返す。

    席も入れ替える（先にボタンを持つ方が少し有利なため）。
    """
    busted = 0
    survived = 0
    total_hands = 0
    for i in range(matches):
        seat = i % 2
        policies = (a, b) if seat == 0 else (b, a)
        result = play_match(policies, seed=seed * 1000 + i, start_stack=start_stack,
                            max_hands=max_hands, fractions=config.RAISE_FRACTIONS,
                            max_raises=config.MAX_RAISES_PER_STREET)
        total_hands += result.hands
        if result.busted == seat:
            busted += 1
        elif result.busted < 0:
            survived += 1
    return Survival(matches, busted, survived, total_hands / matches)


def against_baselines(
    policy: PolicyFn,
    baselines: dict[str, PolicyFn],
    hands: int = 20_000,
    seed: int = 1,
    start_stack: int = 200,
) -> dict[str, dict]:
    """基準の相手ひとりひとりと対戦して結果を並べる。"""
    out: dict[str, dict] = {}
    for name, opponent in baselines.items():
        out[name] = head_to_head(policy, opponent, hands=hands, seed=seed,
                                 start_stack=start_stack).as_dict()
    return out


def score_of(results: dict[str, dict]) -> float:
    """「一番よい学習結果」を選ぶための 1 つの数字。全部の相手に対する mbb/hand の平均。"""
    if not results:
        return 0.0
    return sum(r["mbb_per_hand"] for r in results.values()) / len(results)


def _main() -> None:
    r"""コマンドラインから、ちゃんとした局数で強さを測る。

        cd backend
        .\.venv\Scripts\python -m rl.poker.evaluate --agent n1:latest
        .\.venv\Scripts\python -m rl.poker.evaluate --agent n1:latest --hands 60000 --jsonl 強さ.jsonl

    学習中の自動評価は速さのため局数を절約しているので、**本当の強さはこれで測る**。
    """
    import argparse
    import json
    import time
    from datetime import datetime, timezone

    from .exploit import _load_policy

    ap = argparse.ArgumentParser(description="ポーカー AI の強さをちゃんとした局数で測る")
    ap.add_argument("--agent", default="n1:latest",
                    help='"n1:latest"（ネット + その場で解く）、"n1:latest:net"（ネットだけ）、'
                         'pt/npz のファイルの場所')
    ap.add_argument("--opponents", default="heuristic,heuristic-loose",
                    help="相手の ID をコンマ区切りで（AI の ID も使える。例: n1:latest:net）")
    ap.add_argument("--hands", type=int, default=24_000)
    ap.add_argument("--stack-bb", type=int, default=100)
    ap.add_argument("--workers", type=int, default=1,
                    help="対戦を分けるプロセス数（その場で解く AI は 1 手 1〜2 秒かかるので多めに）")
    ap.add_argument("--matches", type=int, default=0, help="退場のしにくさを測る回数（0 = 測らない）")
    ap.add_argument("--seed", type=int, default=777)
    ap.add_argument("--jsonl", default="", help="結果を 1 行足すファイル（推移を残したいとき）")
    args = ap.parse_args()

    from . import players  # 循環参照を避けるため、ここで読む

    stack = args.stack_bb * BIG_BLIND
    row: dict = {"agent": args.agent, "stack_bb": args.stack_bb, "hands": args.hands,
                 "at": datetime.now(timezone.utc).isoformat()}
    for name in args.opponents.split(","):
        name = name.strip()
        if not name:
            continue
        t0 = time.time()
        r = head_to_head_parallel(args.agent, name, hands=args.hands, workers=args.workers,
                                  seed=args.seed + len(name), start_stack=stack)
        row[f"vs_{name}"] = r.as_dict()
        print(f"  vs {name:<16} {r}  ({time.time() - t0:.0f} 秒)")
    if args.matches:
        me = _load_policy(args.agent, seed=11)
        s = survival(me, players.BASELINES["heuristic"](7), matches=args.matches,
                     start_stack=stack, max_hands=300, seed=args.seed)
        row["survival"] = s.as_dict()
        print(f"  飛んだ割合 {s.bust_rate:.0%}（{s.matches} 回・平均 {s.avg_hands:.0f} 局）")
    if args.jsonl:
        with open(args.jsonl, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + chr(10))


if __name__ == "__main__":
    _main()
