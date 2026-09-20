# tools/video/ 動画の素材づくり

学習した重みを並べて遊ばせ、**連番 PNG** にする。撮影も手編集もせず、計算だけで映像を作るためのもの。
漢字のテロップ・字幕・音声は入れない（YMM4 側で載せたほうが後から直せるため）。ここが作るのは「絵」だけ。

| ファイル | 中身 |
|---|---|
| `png.py` | 依存なしの PNG 書き出し（`zlib` のみ）。`Canvas` と 7 セグの数字描画 |
| `tetris_clip.py` | テトリスの重みを並べて遊ばせ、連番 PNG にする |

## 使い方

```powershell
cd backend
# 世代を 3 つ並べる（すぐ死ぬ頃 / T スピンを覚えた頃 / テトリスを覚えた頃）
.\.venv\Scripts\python -m tools.video.tetris_clip `
    --checkpoints ep_001500 ep_003250 ep_007250 --cell 24 --out tools/video/out/growth

# ルールベース（人が重みを決めた AI）との比較は --checkpoints に best.pt などを指定して別途
```

出来た PNG を mp4 にするコマンドは、実行の最後に表示される（ffmpeg が必要）。

## 決まりごと
- ミノの色は `frontend/src/games/tetris/components/colors.ts` と同じにする（画面と動画で色が変わらないように）。
- 同じ `--seed` ならツモ順が同じになる。**世代の差だけを見せたいので seed は揃える**。
- 盤面の色は `Game` 本体が持っていないので `play()` が自前で持つ。毎手 `game.board.rows` と
  一致するか `assert` しているので、ずれたらその場で落ちる。
- `out/` は Git に入れない（`.gitignore`）。
