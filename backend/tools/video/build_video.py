r"""台本（daihon.csv）から動画を丸ごと作る。人の操作はいらない。

    cd backend
    .\.venv\Scripts\python -m tools.video.build_video

やっていること:

1. `tts.py` で 51 行ぶんのゆっくり音声（AquesTalk）を作り、1 本の音声トラックに並べる
2. 区間ごとに背景を決める（AI の対戦映像 / 文字だけの画面）。
   対戦映像は `tetris_clip.py` で **その区間の長さちょうどに** 描き直す（早送りにも引き伸ばしにもならない）
3. セリフを字幕（ASS）にする。霊夢は赤、魔理沙は黄色
4. ffmpeg で 1 本の mp4 にまとめる

YMM4 は使わない（立ち絵と口パクは入らない）。音声は YMM4 と同じ AquesTalk なので声は同じ。
"""

from __future__ import annotations

import argparse
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

from rl.tetris.agent import HeuristicAgent, NeuralAgent

from .ffmpeg import find_ffmpeg
from .tetris_clip import play, render
from .tts import Line, read_script, synthesize

W, H, FPS = 1280, 720, 30
GAP = 0.28  # セリフとセリフの間（秒）
SECTION_GAP = 0.7  # 話題が変わるところの間
BG_COLOR = "#101218"

# 字幕の色（ASS は &HAABBGGRR の順。RGB ではないので注意）
SPEAKER_COLOR = {"ゆっくり霊夢": "&H008080FF", "ゆっくり魔理沙": "&H0080F0FF"}


@dataclass
class Section:
    """台本の何行目から何行目までを、どの背景で見せるか。"""

    first: int
    last: int
    kind: str  # "growth" | "rulebase" | "text"
    title: str = ""  # kind="text" のとき画面の真ん中に出す文字


SECTIONS = [
    Section(0, 5, "growth"),
    Section(6, 12, "text", "AIにコードを出してもらえば\n自分の分野で機械学習ができる"),
    Section(13, 16, "text", "テトリス／落ち物パズル／オセロ\nエアホッケー／レース／将棋"),
    Section(17, 42, "rulebase"),
    Section(43, 50, "text", "知りたい分野があるなら\n自分の手で試せる"),
]


def layout(lines: list[Line]) -> float:
    """各行の開始時刻（秒）を決めて、動画全体の長さを返す。"""
    starts = {s.first for s in SECTIONS}
    t = 0.5  # 頭に少し余白
    for ln in lines:
        if ln.index in starts and ln.index != 0:
            t += SECTION_GAP
        ln.start = t
        t += ln.seconds + GAP
    return t + 1.0  # 最後にも余白


def write_audio(lines: list[Line], out: Path) -> None:
    """各行の WAV を開始時刻の位置に置いた、1 本の音声トラックを作る。

    AquesTalk は 8kHz・16bit・モノラル。そのまま同じ形式で書き出す（ffmpeg が後で変換する）。
    """
    rate, width = 8000, 2
    total = int((max(ln.start + ln.seconds for ln in lines) + 1.0) * rate)
    buf = bytearray(total * width)
    for ln in lines:
        with wave.open(str(ln.wav)) as w:
            assert w.getframerate() == rate and w.getsampwidth() == width and w.getnchannels() == 1
            data = w.readframes(w.getnframes())
        off = int(ln.start * rate) * width
        buf[off:off + len(data)] = data
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(bytes(buf))


def section_span(lines: list[Line], s: Section) -> tuple[float, float]:
    """区間の開始時刻と長さ（秒）。次の区間が始まるまでを受け持つ。"""
    start = lines[s.first].start - (SECTION_GAP if s.first else 0.5)
    last = lines[s.last]
    end = last.start + last.seconds + GAP
    return max(0.0, start), end - max(0.0, start)


def render_gameplay(kind: str, seconds: float, out_dir: Path, run: str) -> Path:
    """対戦映像を、指定の長さちょうどになるように描く。

    1 手あたりのフレーム数（hold）を長さから逆算するので、
    短い区間なら速く、長い区間ならゆっくり打つ映像になる。
    """
    # max_pieces は台本が読み上げる数字と一致させること。
    # rulebase の 300 手が「119 段 / 116 段、テトリス 0 回 / 15 回」にあたる（400 手だと 158/157 になる）。
    if kind == "growth":
        names, cell, max_pieces = ["ep_001500", "ep_003250", "ep_007250"], 24, 200
    else:
        names, cell, max_pieces = ["heuristic", "best"], 28, 300
    steps = []
    for name in names:
        agent = (HeuristicAgent() if name == "heuristic"
                 else NeuralAgent.load(Path("runs/tetris") / run / "checkpoints" / f"{name}.pt"))
        steps.append((name, play(agent, seed=7, max_pieces=max_pieces)))
    need = int(seconds * FPS)
    longest = max(len(s) for _, s in steps)
    hold = max(1, round(need / longest))
    frames = out_dir / kind
    render(steps, frames, cell, hold, W, H)
    return frames


def write_ass(lines: list[Line], out: Path) -> None:
    """字幕ファイル（ASS）。セリフは下、区間の見出しは真ん中に出す。"""

    def ts(sec: float) -> str:
        h, rem = divmod(max(0.0, sec), 3600)
        m, s = divmod(rem, 60)
        return f"{int(h)}:{int(m):02d}:{s:05.2f}"

    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,"
        " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,"
        " Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for name, color in (("Reimu", SPEAKER_COLOR["ゆっくり霊夢"]), ("Marisa", SPEAKER_COLOR["ゆっくり魔理沙"])):
        # Alignment 2 = 下の中央、Outline 4 = 黒フチを太めに（ゲーム画面の上でも読めるように）
        head.append(f"Style: {name},メイリオ,42,{color},&H000000FF,&H00000000,&H64000000,"
                    f"-1,0,0,0,100,100,0,0,1,4,2,2,60,60,36,1")
    head.append("Style: Title,メイリオ,56,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,"
                "-1,0,0,0,100,100,0,0,1,4,2,5,60,60,0,1")
    head += ["", "[Events]",
             "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    ev = []
    for s in SECTIONS:
        if s.kind == "text" and s.title:
            st, dur = section_span(lines, s)
            text = s.title.replace("\n", r"\N")
            ev.append(f"Dialogue: 0,{ts(st + 0.2)},{ts(st + dur - 0.2)},Title,,0,0,0,,{text}")
    for ln in lines:
        style = "Reimu" if ln.character == "ゆっくり霊夢" else "Marisa"
        ev.append(f"Dialogue: 1,{ts(ln.start)},{ts(ln.start + ln.seconds + GAP * 0.7)},{style},,0,0,0,,{ln.serif}")
    out.write_text("\n".join(head + ev) + "\n", encoding="utf-8-sig")


def build_background(lines: list[Line], out_dir: Path, run: str, ff: str) -> Path:
    """区間ごとの背景を作って 1 本につなぐ。"""
    parts = []
    for i, s in enumerate(SECTIONS):
        _, dur = section_span(lines, s)
        seg = out_dir / f"bg_{i:02d}.mp4"
        if s.kind == "text":
            subprocess.run([ff, "-y", "-loglevel", "error", "-f", "lavfi",
                            "-i", f"color=c={BG_COLOR}:s={W}x{H}:r={FPS}:d={dur:.3f}",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(seg)], check=True)
        else:
            frames = render_gameplay(s.kind, dur, out_dir / "frames", run)
            subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", str(FPS),
                            "-i", str(frames / "frame_%05d.png"), "-t", f"{dur:.3f}",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(seg)], check=True)
        parts.append(seg)
    lst = out_dir / "bg_list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    bg = out_dir / "bg.mp4"
    # cwd を移すので、渡すのはファイル名だけにする（相対パスが二重になる）
    subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", lst.name, "-c", "copy", bg.name], check=True, cwd=out_dir)
    return bg


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--script", default="tools/video/daihon.csv")
    p.add_argument("--run", default="v3-selfplay")
    p.add_argument("--out", default="tools/video/out/movie.mp4")
    a = p.parse_args()

    ff = find_ffmpeg()
    if ff is None:
        raise SystemExit("ffmpeg が見つからない。`winget install ffmpeg` のあとシェルを開き直すこと。")

    work = Path(a.out).parent / "work"
    work.mkdir(parents=True, exist_ok=True)

    lines = read_script(Path(a.script))
    print(f"台本 {len(lines)} 行 → 音声を合成中…")
    synthesize(lines, work / "voice")
    total = layout(lines)
    print(f"動画の長さ: {total:.1f} 秒（{total / 60:.1f} 分）")

    write_audio(lines, work / "voice.wav")
    write_ass(lines, work / "sub.ass")
    print("背景を作成中…")
    bg = build_background(lines, work, a.run, ff)

    out = Path(a.out)
    print("字幕と音声を合成中…")
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", bg.name, "-i", "voice.wav",
                    # ASS は libass が描く。Windows のパスは : を含むと filter 記法と衝突するので
                    # 作業フォルダに cd して相対名で渡す
                    "-vf", "subtitles=sub.ass",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-shortest",
                    str(out.resolve())], check=True, cwd=work)
    print(f"\n完成: {out}")


if __name__ == "__main__":
    main()
