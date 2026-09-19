"""TypeScript 版エンジンとの一致を確かめるテストデータを作る。

実行: cd backend; python -m games.tetris.fixtures
出力: shared/fixtures/engine_cases.json

各ケースは「seed と操作列」と「最後の状態・固定ごとの結果」を持つ。
TypeScript 側（frontend/src/engine/engine.test.ts）が同じ操作を再生して比べる。
"""

from __future__ import annotations

import json
from pathlib import Path

from .features import board_features
from .game import Game
from .lock import resolve_lock
from .movegen import find_placements
from .rng import BagRandomizer, Mulberry32

OUT = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "tetris" / "engine_cases.json"


def _heuristic(game: Game, c) -> float:
    out = resolve_lock(game.board, c.piece, c.rot, c.x, c.y, c.spin, game.combo, game.b2b, game.pending)
    f = board_features(out.board)
    return f.agg_height * 0.5 + f.holes * 4 + f.bumpiness * 0.3 - out.lines * 2 - out.attack * 3


def _random_case(seed: int, max_pieces: int) -> dict:
    """置き場所をランダムに選んで遊ぶ。T-Spin や回転入れも混ざるよう、全置き場所から選ぶ。"""
    game = Game(seed=seed)
    pick = Mulberry32(seed * 7919 + 1)
    actions: list[str] = []
    locks: list[dict] = []
    garbage: dict[int, int] = {}  # 何手目の前に何段受け取るか

    for i in range(max_pieces):
        if game.over:
            break
        if i % 9 == 4:
            amount = 1 + pick.next_int(2)
            game.receive_garbage(amount)
            garbage[len(actions)] = amount
        use_hold = pick.next_int(6) == 0 and game.can_hold
        if use_hold:
            game.hold()
            actions.append("HOLD")
            if game.over:
                break
        assert game.current is not None
        candidates = find_placements(game.board, game.current.type)
        # 簡単な評価で最善手（4 回に 1 回は次善手）を選ぶ（列が消えて長く続くように）
        candidates.sort(key=lambda c: _heuristic(game, c))
        choice = candidates[1 if len(candidates) > 1 and pick.next_int(4) == 0 else 0]
        for a in choice.path:
            game.apply(a)
            actions.append(a)
        result = game.hard_drop()
        actions.append("HD")
        locks.append(result.to_dict())

    return {"seed": seed, "actions": actions, "garbage": garbage, "locks": locks, "final": game.snapshot()}


def _tspin_case() -> dict:
    """T-Spin Double を必ず含む手組みケース（Python 側テストの確認用にも使う）。"""
    # 下 2 段に T 字の穴、3 段目の列 3 に屋根 → T を CW, SDB, CW で入れると TSD
    setup_rows = [0x3FF & ~(1 << 4), 0x3FF & ~((1 << 3) | (1 << 4) | (1 << 5)), 1 << 3]
    game = Game(seed=1)
    game.board.rows[: len(setup_rows)] = setup_rows
    game.force_current("T")
    actions = ["CW", "SDB", "CW"]
    for a in actions:
        game.apply(a)
    result = game.hard_drop()
    return {
        "setup_rows": setup_rows,
        "actions": actions + ["HD"],
        "lock": result.to_dict(),
        "final_rows": list(game.board.rows),
    }


def build() -> dict:
    r = Mulberry32(12345)
    bag = BagRandomizer(42)
    return {
        "rng": {"seed": 12345, "values": [r.next_float() for _ in range(10)]},
        "bags": {"seed": 42, "pieces": bag.next_bag() + bag.next_bag() + bag.next_bag()},
        "random_games": [_random_case(seed, 120) for seed in (1, 2, 3, 7, 99)],
        "tspin_double": _tspin_case(),
    }


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
