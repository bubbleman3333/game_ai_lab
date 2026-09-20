r"""台本（daihon.csv）から動画を丸ごと作る。人の操作はいらない。

    cd backend
    .\.venv\Scripts\python -m tools.video.build_video

やっていること:

1. `tts.py` で 51 行ぶんのゆっくり音声（AquesTalk）を作り、1 本の音声トラックに並べる
2. `bgm.py` で BGM を合成する（配布物を落とさないので権利の確認が要らない）
3. 区間ごとに背景を決める。AI の対戦映像は `tetris_clip.py` で
   **その区間の長さちょうどに** 描くので、早送りにも引き伸ばしにもならない
4. 立ち絵（`yukkuri.py`）を重ね、音の大きさから口パクを付ける
5. 出来た絵を ffmpeg に流し込み、字幕（ASS）と音を乗せて mp4 にする

フレームはファイルに書かず、生の RGB のまま ffmpeg に渡す（6000 枚を PNG で書くと遅いため）。
"""

from __future__ import annotations

import argparse
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from rl.tetris.agent import HeuristicAgent, NeuralAgent

from . import bgm
from .ffmpeg import find_ffmpeg
from .png import Canvas, hex_color
from .tetris_clip import Step, frame_canvas, play
from .tts import Line, mouth_track, read_script, synthesize
from .yukkuri import compile_all

W, H, FPS = 1280, 720, 30
GAME_H = 560  # 盤面を描く範囲（下は立ち絵と字幕のために空ける）
FACE_H = 195
FACE_Y = H - FACE_H
FACE_X = {"reimu": 8, "marisa": W - FACE_H - 8}
GAP = 0.28  # セリフとセリフの間（秒）
SECTION_GAP = 0.7  # 話題が変わるところの間
BG = hex_color("#101218")
BGM_DB = -21  # BGM の音量（声より十分小さく）

CHAR_KEY = {"ゆっくり霊夢": "reimu", "ゆっくり魔理沙": "marisa"}
SPEAKER_COLOR = {"reimu": "&H008080FF", "marisa": "&H0080F0FF"}  # ASS は &HAABBGGRR


@dataclass
class Section:
    """台本の何行目から何行目までを、どの背景で見せるか。"""

    first: int
    last: int
    kind: str  # "growth" | "rulebase" | "text"
    title: str = ""


SECTIONS = [
    Section(0, 5, "growth"),
    Section(6, 12, "text", "AIにコードを出してもらえば\n自分の分野で機械学習ができる"),
    Section(13, 16, "text", "テトリス／落ち物パズル／オセロ\nエアホッケー／レース／将棋"),
    Section(17, 42, "rulebase"),
    Section(43, 50, "text", "知りたい分野があるなら\n自分の手で試せる"),
]

# 手数は台本が読み上げる数字と一致させること。
# rulebase の 300 手が「119 段 / 116 段、テトリス 0 回 / 15 回」にあたる。
GAMEPLAY = {
    "growth": (["ep_001500", "ep_003250", "ep_007250"], 20, 200),
    "rulebase": (["heuristic", "best"], 24, 300),
}


def layout(lines: list[Line]) -> float:
    """各行の開始時刻（秒）を決めて、動画全体の長さを返す。"""
    starts = {s.first for s in SECTIONS}
    t = 0.5
    for ln in lines:
        if ln.index in starts and ln.index != 0:
            t += SECTION_GAP
        ln.start = t
        t += ln.seconds + GAP
    return t + 1.0


def write_audio(lines: list[Line], out: Path) -> None:
    """各行の WAV を開始時刻の位置に置いた、1 本の音声トラックを作る。"""
    import wave

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
    """区間の開始時刻と長さ（秒）。"""
    start = max(0.0, lines[s.first].start - (SECTION_GAP if s.first else 0.5))
    last = lines[s.last]
    return start, last.start + last.seconds + GAP - start


def load_gameplay(kind: str, run: str) -> list[tuple[str, list[Step]]]:
    """対戦を実際に打たせて、1 手ごとの盤面を集める。"""
    names, _, max_pieces = GAMEPLAY[kind]
    out = []
    for name in names:
        agent = (HeuristicAgent() if name == "heuristic"
                 else NeuralAgent.load(Path("runs/tetris") / run / "checkpoints" / f"{name}.pt"))
        out.append((name, play(agent, seed=7, max_pieces=max_pieces)))
    return out


def mouth_frames(lines: list[Line], total_frames: int) -> dict[str, list[str]]:
    """キャラごとに、1 フレームずつの口の形。しゃべっていない間は閉じたまま。"""
    tracks = {k: ["close"] * total_frames for k in CHAR_KEY.values()}
    for ln in lines:
        who = CHAR_KEY[ln.character]
        n = math.ceil(ln.seconds * FPS)
        track = mouth_track(ln, FPS, n)
        off = int(ln.start * FPS)
        for i, m in enumerate(track):
            f = off + i
            if 0 <= f < total_frames:
                tracks[who][f] = m
    return tracks


def write_ass(lines: list[Line], out: Path) -> None:
    """字幕ファイル（ASS）。セリフは下の真ん中（立ち絵の間）、見出しは画面中央。"""

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
    # 左右の余白は立ち絵ぶん空ける。Alignment 2 = 下の中央
    for style, who in (("Reimu", "reimu"), ("Marisa", "marisa")):
        head.append(f"Style: {style},メイリオ,38,{SPEAKER_COLOR[who]},&H000000FF,&H00000000,&H64000000,"
                    f"-1,0,0,0,100,100,0,0,1,4,2,2,{FACE_H + 24},{FACE_H + 24},28,1")
    head.append("Style: Title,メイリオ,54,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,"
                "-1,0,0,0,100,100,0,0,1,4,2,5,60,60,90,1")
    head += ["", "[Events]",
             "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    ev = []
    for s in SECTIONS:
        if s.kind == "text" and s.title:
            st, dur = section_span(lines, s)
            ev.append(f"Dialogue: 0,{ts(st + 0.2)},{ts(st + dur - 0.2)},Title,,0,0,0,,"
                      + s.title.replace("\n", r"\N"))
    for ln in lines:
        style = "Reimu" if CHAR_KEY[ln.character] == "reimu" else "Marisa"
        ev.append(f"Dialogue: 1,{ts(ln.start)},{ts(ln.start + ln.seconds + GAP * 0.7)},{style},,0,0,0,,{ln.serif}")
    out.write_text("\n".join(head + ev) + "\n", encoding="utf-8-sig")


def generate_frames(lines: list[Line], total_frames: int, run: str, sink) -> None:
    """1 フレームずつ描いて sink（ffmpeg の標準入力）に生の RGB を書く。"""
    faces = compile_all(FACE_H)
    tracks = mouth_frames(lines, total_frames)
    clips = {k: load_gameplay(k, run) for k in {s.kind for s in SECTIONS} & GAMEPLAY.keys()}
    spans = [(s, *section_span(lines, s)) for s in SECTIONS]

    for f in range(total_frames):
        t = f / FPS
        sec = next((x for x in spans if x[1] <= t < x[1] + x[2]), spans[-1])
        s, start, dur = sec
        if s.kind in clips:
            runs = clips[s.kind]
            n = max(len(st) for _, st in runs)
            # 区間の長さに手数を割り当てる。早送りにも引き伸ばしにもならない
            i = min(n - 1, int((t - start) / dur * n))
            cell = GAMEPLAY[s.kind][1]
            cv = frame_canvas(runs, i, cell, W, GAME_H)
            full = Canvas(W, H, BG)
            full.buf[:W * GAME_H * 3] = cv.buf
        else:
            full = Canvas(W, H, BG)
        for who in ("reimu", "marisa"):
            faces[(who, tracks[who][f])].blit(full, FACE_X[who], FACE_Y)
        sink.write(bytes(full.buf))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--script", default="tools/video/daihon.csv")
    p.add_argument("--run", default="v3-selfplay")
    p.add_argument("--out", default="tools/video/out/movie.mp4")
    p.add_argument("--no-bgm", action="store_true")
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
    frames = int(total * FPS)
    print(f"動画の長さ: {total:.1f} 秒（{total / 60:.1f} 分） / {frames} フレーム")

    write_audio(lines, work / "voice.wav")
    write_ass(lines, work / "sub.ass")
    if not a.no_bgm:
        print("BGM を合成中…")
        bgm.write(work / "bgm.wav", total)

    cmd = [ff, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", "voice.wav"]
    if a.no_bgm:
        cmd += ["-map", "0:v", "-map", "1:a"]
    else:
        cmd += ["-i", "bgm.wav",
                "-filter_complex", f"[2:a]volume={BGM_DB}dB[b];[1:a][b]amix=inputs=2:duration=first[a]",
                "-map", "0:v", "-map", "[a]"]
    # ASS は libass が描く。Windows のパスは : が filter 記法と衝突するので、
    # 作業フォルダに cd して相対名で渡す
    cmd += ["-vf", "subtitles=sub.ass",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest",
            str(Path(a.out).resolve())]

    print("映像を描きながら書き出し中…")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, cwd=work)
    try:
        generate_frames(lines, frames, a.run, proc.stdin)
    finally:
        proc.stdin.close()
        if proc.wait() != 0:
            raise SystemExit("ffmpeg が失敗した")
    print(f"\n完成: {a.out}")


if __name__ == "__main__":
    main()
