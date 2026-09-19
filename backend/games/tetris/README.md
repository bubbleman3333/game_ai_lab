# games/tetris/ テトリスのルールエンジン（Python）

Django にも PyTorch にも依存しない。仕様は [docs/TETRIS_RULES.md](../../../docs/TETRIS_RULES.md)。
**同じものが TypeScript 版（`frontend/src/games/tetris/engine/`）にもある。片方だけ変えないこと。**

| ファイル | 中身 |
|---|---|
| `pieces.py` | ミノの形・SRS の kick 表・T の四隅 |
| `rng.py` | 乱数（mulberry32）と 7-bag（TS 版と同じ値を出す） |
| `board.py` | 盤面（1 行 = 10bit 整数、y=0 が最下段）・衝突判定・消去・せり上がり |
| `rules.py` | T-Spin 判定・火力計算・相殺（盤面を持たない関数） |
| `lock.py` | 固定したときの処理一式 `resolve_lock()`（Game と AI の先読みで共通） |
| `game.py` | `Game`: 1 人分の状態と操作（`move` `rotate` `hard_drop` `hold` `receive_garbage` …） |
| `movegen.py` | `find_placements()`: 置ける場所と、そこへの操作列を幅優先探索で全部出す（T-Spin の回し入れも含む） |
| `features.py` | 盤面の特徴量（穴・高さ・凸凹・T-Spin の穴の数など） |
| `fixtures.py` | TS 版と突き合わせるテストデータを作る（`python -m games.tetris.fixtures`） |

## 試す
```python
from games.tetris import Game, find_placements
g = Game(seed=1)
g.move(-1); g.rotate(1)
r = g.hard_drop()        # LockResult(lines, spin, attack, sent, ...)
print(g.board)           # '#' と '.' で表示
for p in find_placements(g.board, g.current.type)[:3]:
    print(p.x, p.y, p.rot, p.spin, p.path)
```
