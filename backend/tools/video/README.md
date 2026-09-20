# tools/video/ 動画を丸ごと作る

台本（`daihon.csv`）から、ゆっくり解説の動画を **人の操作なしで** 作る。
撮影も編集もしない。映像は学習した重みを遊ばせて計算で描き、音声は AquesTalk で合成する。

```powershell
cd backend
.\.venv\Scripts\python -m tools.video.build_video      # → tools/video/out/movie.mp4
```

| ファイル | 中身 |
|---|---|
| `daihon.csv` | 台本。1 列目 キャラクター名 / 2 列目 セリフ（字幕） / 3 列目 読み仮名（音声） |
| `build_video.py` | 全体の組み立て。区間割り・音声トラック・立ち絵・字幕・ffmpeg |
| `tts.py` | ゆっくり音声の合成（AquesTalk1）と、音の大きさからの口パク |
| `yukkuri.py` | 霊夢・魔理沙の立ち絵をコードで描く。口の形は 3 段階 |
| `bgm.py` | BGM をコードで合成する（配布物を落とさないので権利の確認が要らない） |
| `aqtalk.ps1` | 32bit PowerShell から AquesTalk.dll を呼ぶ。**ASCII だけで書くこと** |
| `tetris_clip.py` | 学習した重みを並べて遊ばせ、連番 PNG にする |
| `png.py` | 依存なしの PNG 書き出し（`zlib` のみ） |
| `ffmpeg.py` | 連番 PNG → mp4。ffmpeg の場所探しも |

## 必要なもの
- **ffmpeg**（`winget install ffmpeg`）
- **YMM4 を解凍したフォルダ**。同梱の `Resources/AquesTalk` を音声合成に使う。
  YMM4 を起動する必要はない。置き場所は `tts.py` の `YMM4_HINTS`。

## つまずきやすいところ
- `AquesTalk.dll` は **32bit**。64bit の Python からは読めないので、Windows 標準の
  32bit PowerShell（`SysWOW64`）経由で呼ぶ。追加のインストールは要らない。
- 読み仮名は **カタカナの音声記号列**。`、` `。` `？` `/` は使えるが、
  **半角スペース・`・`・`ヅ`・`ヂ` は使えない**（エラー 105）。`tts.py` の `BAD_KANA` が事前に弾く。
- `aqtalk.ps1` に日本語を書くと、Windows PowerShell 5.1 が ANSI として読んで文字化けする。
  **テキストは UTF-8 の TSV で渡す**。
- **台本が読み上げる数字と、映像の `max_pieces` を一致させること**。
  `build_video.render_gameplay` の 300 手が「119 段 / 116 段、テトリス 0 回 / 15 回」にあたる。
  ここがずれると、声と画面の数字が食い違う。
- 区間の長さに合わせて 1 手あたりのフレーム数を逆算するので、映像は早送りにも引き伸ばしにもならない。
- ミノの色は `frontend/src/games/tetris/components/colors.ts` と同じにする。
- `out/` は Git に入れない（`.gitignore`）。
- フレームはファイルに書かず、生の RGB のまま ffmpeg に流す。6000 枚を PNG で書くと遅いため。
- 立ち絵を 1 画素ずつ重ねると 1 フレーム 10 万回になって終わらない。
  `yukkuri.compile_sprite` が不透明な横並びをまとめ、スライス代入で書く。

## 直したいとき
- セリフ → `daihon.csv`。**2 列目（字幕）と 3 列目（読み）の両方**を直す。
- 区間の割り当て・見出し → `build_video.py` の `SECTIONS`。
- 字幕の色や大きさ → `build_video.write_ass`。立ち絵の大きさ・位置 → `FACE_H` と `FACE_X`。
- BGM の音量 → `build_video.BGM_DB`（既定 -21dB）。曲そのもの → `bgm.py` の `PROGRESSION`。
  BGM 無しで作るなら `--no-bgm`。
- **本物のゆっくり素材に差し替えたいとき** → `yukkuri.load_or_draw` にフォルダを渡し、
  そこに `reimu_close.png` `reimu_half.png` `reimu_open.png` と魔理沙ぶんの 6 枚（透過 PNG）を置く。
