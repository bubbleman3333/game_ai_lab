"""TypeScript 版エンジンとの一致を確かめるテストデータを作る。

実行: cd backend; python -m games.blob.fixtures
出力: shared/fixtures/blob/engine_cases.json

各ケースは「seed と、1 手ごとの操作列」と「1 手ごとの結果・盤面」を持つ。
TypeScript 側（frontend/src/games/blob/engine/fixtures.test.ts）が同じ操作を再生して比べる。
"""

from __future__ import annotations

import json
from pathlib import Path

from .game import BlobGame
from .rules import Field, H, Rng, VISIBLE_H, W

OUT = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "blob" / "engine_cases.json"


def _pick(game: BlobGame, rng: Rng) -> tuple[int, int, list[str]] | None:
    """置き場所を選ぶ。連鎖が起きる手を少し優先して、テストデータに連鎖を混ぜる。"""
    best: tuple[float, int, int, list[str]] | None = None
    for rot in range(4):
        for x in range(W):
            actions = game.path_to(x, rot)
            if actions is None:
                continue
            trial = BlobGame.from_state(game.field.clone(), game.current, pending=game.pending,
                                        carry=game.carry, all_clear_bonus=game.all_clear_bonus)
            r = trial.place(x, rot)
            heights = trial.field.heights()
            score = r.chain * 12 + r.sent * 2 - max(heights) - sum(
                abs(heights[i] - heights[i + 1]) for i in range(W - 1)
            ) * 0.4 + rng.next() * 3
            if max(heights) >= H:
                score -= 100
            if best is None or score > best[0]:
                best = (score, x, rot, actions)
    if best is None:
        return None
    return best[1], best[2], best[3]


def _rows(game: BlobGame) -> list[str]:
    """盤面を下の行から 1 行 6 文字の文字列にする（読みやすさのため）。"""
    return ["".join(str(game.field.cells[y * W + x]) for x in range(W)) for y in range(H)]


def _field_of(rows: list[str]) -> Field:
    f = Field()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            f.set(x, y, int(ch))
    return f


def _random_case(seed: int, max_pairs: int) -> dict:
    game = BlobGame(seed=seed)
    pick = Rng(seed * 7919 + 1)
    turns: list[dict] = []
    for i in range(max_pairs):
        if game.over or game.current is None:
            break
        garbage = 0
        if i % 11 == 7:
            garbage = 1 + pick.int(12)
            game.receive_garbage(garbage)
        choice = _pick(game, pick)
        if choice is None:
            break
        x, rot, actions = choice
        result = game.place(x, rot)
        game.drop_garbage()
        game.spawn()
        turns.append({
            "garbage": garbage,
            "actions": actions,
            "chain": result.chain,
            "score": result.score,
            "attack": result.attack,
            "cancelled": result.cancelled,
            "sent": result.sent,
            "all_clear": result.all_clear,
            "rows": _rows(game),
            "pending": game.pending,
        })
    return {"seed": seed, "turns": turns, "final": game.snapshot()}


def _chain_case() -> dict:
    """4 連鎖以上になる盤面を 1 つ探して、その 1 手だけを取り出したケース。

    手で組むと間違えやすいので、_pick で遊ばせて見つかった盤面をそのまま記録する。
    連鎖の得点・送るおじゃまの数が TypeScript 版と一致するかの確認用。
    """
    for seed in range(1, 400):
        game = BlobGame(seed=seed)
        pick = Rng(seed * 104729 + 3)
        for _ in range(120):
            if game.over or game.current is None:
                break
            before = _rows(game)
            pair = game.current
            choice = _pick(game, pick)
            if choice is None:
                break
            x, rot, _ = choice
            result = game.place(x, rot)
            if result.chain >= 4:
                # 持ち越しの得点などが混ざらないよう、まっさらな状態でもう一度だけ置いてみる
                solo = BlobGame.from_state(_field_of(before), pair)
                r = solo.place(x, rot)
                return {
                    "setup": before, "place": [x, rot], "axis": pair.axis, "child": pair.child,
                    "chain": r.chain, "score": r.score, "attack": r.attack,
                    "sent": r.sent, "rows": _rows(solo),
                }
            game.drop_garbage()
            game.spawn()
    raise RuntimeError("4 連鎖する盤面が見つかりませんでした")


def _garbage_case() -> dict:
    """おじゃまの降り方（端数の列の選び方）が一致するか。"""
    game = BlobGame(seed=777)
    game.receive_garbage(40)  # 1 回目 30 個、2 回目 10 個
    first = game.drop_garbage()
    second = game.drop_garbage()
    return {"seed": 777, "received": 40, "first": first, "second": second, "rows": _rows(game)}


def build() -> dict:
    r = Rng(12345)
    return {
        "size": {"W": W, "H": H, "VISIBLE_H": VISIBLE_H},
        "rng": {"seed": 12345, "values": [r.next() for _ in range(10)]},
        "queues": {"seed": 4242, "pairs": _queue(4242, 12)},
        "random_games": [_random_case(seed, 90) for seed in (1, 2, 3, 7, 99)],
        "chain4": _chain_case(),
        "garbage": _garbage_case(),
    }


def _queue(seed: int, n: int) -> list[list[int]]:
    """出てくる組ぷよの順番（乱数の使い方が一致するかの確認）。"""
    game = BlobGame(seed=seed)
    pairs: list[list[int]] = []
    for i in range(n):
        assert game.current is not None
        pairs.append([game.current.axis, game.current.child])
        game.place(i % W, 0)  # 列を順に使って盤面をあふれさせない
        game.spawn()
    return pairs


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
