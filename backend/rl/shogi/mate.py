"""根の局面で長い詰みを探す（df-pn。cshogi の DfPn）。

cshogi の df-pn は動いている間 Python のロック（GIL）を手放さないので、同じプロセスのスレッドで動かすと
木探索が止まってしまう。そこで別プロセスで動かし、木探索と同時に進める。
詰みが見つかれば、木探索の結果より優先してその手を指す（人間が一番逃しやすいのが長い詰みなので効く）。
"""

from __future__ import annotations

from concurrent.futures import Future, ProcessPoolExecutor

NODES_PER_SEC = 300_000  # df-pn が 1 秒に調べる局面数のおおよそ（時間の上限を局面数に直すのに使う）
MAX_DEPTH = 41  # 何手詰めまで探すか

_pool: ProcessPoolExecutor | None = None


def _solve(sfen: str, max_nodes: int) -> list[str]:
    from cshogi import Board, DfPn, move_to_usi

    board = Board(sfen)
    dfpn = DfPn()
    dfpn.set_max_depth(MAX_DEPTH)
    dfpn.set_max_search_node(max_nodes)
    if board.is_check() or not dfpn.search(board):
        return []
    return [move_to_usi(m) for m in dfpn.get_pv(board)]


def start(sfen: str, seconds: float) -> Future:
    """詰み探索を別プロセスで始める。結果（詰み手順の USI のリスト。無ければ空）は Future で受け取る。"""
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=1)
    return _pool.submit(_solve, sfen, max(10_000, int(seconds * NODES_PER_SEC)))


def finish(job: Future, wait: float = 0.05) -> list[str]:
    """木探索が終わったときに、詰み探索がすぐ終わるなら結果を使う（待ちすぎない）。"""
    try:
        return job.result(timeout=wait)
    except Exception:
        return []  # 時間切れ（そのまま別プロセスで終わるのを待つ。次の探索は少し後ろに並ぶ）
