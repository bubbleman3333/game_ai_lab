"""ゆっくり音声（AquesTalk1）の合成。

YMM4 に同梱されている AquesTalk.dll を直接呼ぶ。この DLL は **32bit** なので、
64bit の Python からは読み込めない。Windows に標準で入っている 32bit の PowerShell
(`SysWOW64`) を経由して呼ぶ（`aqtalk.ps1`）。追加のインストールは要らない。

入力は **カタカナの音声記号列**で、漢字は読めない。`、` `。` `？` `/` は使えるが、
**半角スペースと `・` は使えない**（エラー 105 になる）。読み仮名は `daihon.csv` の 3 列目に持つ。

出力は 8kHz・16bit・モノラルの WAV。YMM4 が作る音と同じもの。
"""

from __future__ import annotations

import csv
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

PS32 = Path(r"C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe")
# YMM4 の置き場所。見つからなければ探す
YMM4_HINTS = [
    Path.home() / "Downloads" / "YukkuriMovieMaker_v4 (1)",
    Path.home() / "Downloads" / "YukkuriMovieMaker_v4",
    Path.home() / "YMM4",
]
# キャラクター名 → AquesTalk の声（.ymmp の Characters[].Voice.Arg と同じ）
VOICE_ARG = {"ゆっくり霊夢": "f1", "ゆっくり魔理沙": "f2"}
ENGINE_DIR = "aq1v2"  # EngineVersion V1_7 に対応するフォルダ


@dataclass
class Line:
    """台本 1 行。"""

    index: int
    character: str
    serif: str  # 画面に出す字幕（漢字かな交じり）
    kana: str  # 読み上げる音声記号列（カタカナ）
    wav: Path | None = None
    seconds: float = 0.0  # 読み上げの長さ
    start: float = 0.0  # 動画の中での開始時刻（build_video.layout が埋める）


def find_aques_root() -> Path:
    """AquesTalk の声フォルダの親（…/Resources/AquesTalk）を返す。"""
    for h in YMM4_HINTS:
        p = h / "Resources" / "AquesTalk"
        if p.is_dir():
            return p
    raise FileNotFoundError("YMM4 の Resources/AquesTalk が見つからない。YMM4_HINTS を足すこと。")


# AquesTalk1 が受け付けない文字（実測）。混ざるとエラー 105 になる
BAD_KANA = {" ", "　", "・", "！", "「", "」", "…", "ヅ", "ヂ", "ヴ", "ゝ"}


def check_kana(kana: str) -> set[str]:
    """使えない文字を返す。空なら大丈夫。"""
    return BAD_KANA & set(kana)


def read_script(path: Path) -> list[Line]:
    """daihon.csv（キャラクター名, セリフ, 読み仮名）を読む。"""
    rows = list(csv.reader(path.open(encoding="utf-8-sig")))
    out = []
    for i, r in enumerate(rows):
        if len(r) < 3:
            raise ValueError(f"{path}:{i + 1} 読み仮名（3 列目）が無い: {r}")
        bad = check_kana(r[2])
        if bad:
            raise ValueError(f"{path}:{i + 1} 読み仮名に使えない文字 {bad}: {r[2]}")
        out.append(Line(i, r[0].strip(), r[1].strip(), r[2].strip()))
    return out


def synthesize(lines: list[Line], out_dir: Path, speed: int = 100) -> list[Line]:
    """各行を WAV にして、長さ（秒）を埋めて返す。"""
    root = find_aques_root()
    out_dir.mkdir(parents=True, exist_ok=True)
    tsv, entries = [], []
    for ln in lines:
        arg = VOICE_ARG.get(ln.character)
        if arg is None:
            raise ValueError(f"知らないキャラクター名: {ln.character}（{VOICE_ARG} のどれか）")
        wav = out_dir / f"line_{ln.index:03d}.wav"
        tsv.append(f"{wav}\t{root / ENGINE_DIR / arg}\t{speed}\t{ln.kana}")
        entries.append((ln, wav))
    job = out_dir / "job.tsv"
    job.write_text("\n".join(tsv), encoding="utf-8")

    script = Path(__file__).with_name("aqtalk.ps1")
    r = subprocess.run(
        [str(PS32), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-InFile", str(job)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    results = [l.split("\t") for l in r.stdout.splitlines() if l.strip()]
    if len(results) != len(entries):
        raise RuntimeError(f"合成の結果が {len(results)} 件（{len(entries)} 件のはず）\n{r.stdout}\n{r.stderr}")
    failed = []
    for (ln, wav), res in zip(entries, results):
        if res[0] != "OK":
            # 105 は「未定義の読み記号」。半角スペース・「・」・「ヅ」などが混ざっている
            failed.append(f"  {ln.index} 行目（コード {res[-1]}）: {ln.kana}")
            continue
        with wave.open(str(wav)) as w:
            ln.seconds = w.getnframes() / w.getframerate()
        ln.wav = wav
    if failed:
        raise RuntimeError("合成に失敗した行がある:\n" + "\n".join(failed))
    return lines


def mouth_track(line: Line, fps: int, frames: int) -> list[str]:
    """セリフの音の大きさから、1 フレームごとの口の形を決める（口パク）。

    しゃべっていない間は閉じたまま。音が大きいほど大きく開く。
    戻り値は "close" / "half" / "open" が frames 個。
    """
    with wave.open(str(line.wav)) as w:
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    n = len(raw) // 2
    step = max(1, rate // fps)
    out = []
    for f in range(frames):
        lo = f * step
        if lo >= n:
            out.append("close")
            continue
        hi = min(n, lo + step)
        # 平均の絶対値で十分（RMS でなくてよい）。1/30 秒ぶんを見る
        total = 0
        for i in range(lo, hi):
            v = int.from_bytes(raw[i * 2:i * 2 + 2], "little", signed=True)
            total += v if v >= 0 else -v
        level = total / max(1, hi - lo) / 32768.0
        out.append("open" if level > 0.085 else "half" if level > 0.025 else "close")
    return out
