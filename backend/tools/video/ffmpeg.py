"""連番 PNG を mp4 にする。ffmpeg の場所探しもここでやる。

winget で入れた直後は PATH が古いシェルに反映されないので、
見つからなければ winget の置き場所も探しに行く。
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
from pathlib import Path

_WINGET = "~/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg*/*/bin/ffmpeg.exe"


def find_ffmpeg() -> str | None:
    """ffmpeg.exe のパス。見つからなければ None。"""
    found = shutil.which("ffmpeg")
    if found:
        return found
    hits = glob.glob(os.path.expanduser(_WINGET))
    return hits[0] if hits else None


def encode(frames_dir: Path, out: Path, fps: int = 30) -> bool:
    """frames_dir の frame_00000.png … を mp4 にする。ffmpeg が無ければ False。"""
    ff = find_ffmpeg()
    if ff is None:
        print("ffmpeg が見つからない。`winget install ffmpeg` のあと、シェルを開き直すこと。")
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ff, "-y", "-loglevel", "error",
        "-framerate", str(fps), "-i", str(frames_dir / "frame_%05d.png"),
        # yuv420p にしないと編集ソフトや SNS で再生できないことがある。
        # 幅・高さが奇数だと libx264 が落ちるので、念のため偶数に切り詰める。
        "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        str(out),
    ]
    subprocess.run(cmd, check=True)
    print(f"mp4 を書き出した: {out}")
    return True
