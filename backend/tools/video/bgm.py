"""BGM をコードで作る。

配布物を落とさずに済ませるため、音そのものを計算で合成している（権利関係の確認が要らない）。
落ち着いたコード進行のパッドに、控えめなアルペジオを重ねただけのもの。
解説のうしろで鳴らす前提なので、音量は小さめ・音域は狭めにしてある。

    .\\.venv\\Scripts\\python -m tools.video.bgm   # 試聴用に 30 秒だけ書き出す
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

RATE = 44100
# Am - F - C - G。1 コード 4 秒で 16 秒ひとまわり
PROGRESSION = [
    (57, 60, 64),  # Am
    (53, 57, 60),  # F
    (48, 52, 55),  # C
    (55, 59, 62),  # G
]
CHORD_SECONDS = 4.0
ARPEGGIO_NOTE = 0.5  # アルペジオ 1 音の長さ（秒）


def hz(midi: int) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _pad(t: float, f: float) -> float:
    """やわらかいパッド。倍音を少しだけ足す。"""
    return (math.sin(2 * math.pi * f * t)
            + 0.30 * math.sin(4 * math.pi * f * t)
            + 0.12 * math.sin(6 * math.pi * f * t))


def _env(pos: float, length: float, attack: float, release: float) -> float:
    """立ち上がりと減衰。ブツッと切れないように。"""
    if pos < attack:
        return pos / attack
    if pos > length - release:
        return max(0.0, (length - pos) / release)
    return 1.0


def render(seconds: float) -> bytes:
    """16bit モノラルの PCM を返す。"""
    n = int(seconds * RATE)
    buf = [0.0] * n
    loop = len(PROGRESSION) * CHORD_SECONDS

    # パッド（コードを重ねて伸ばす）
    chord_i = 0
    t0 = 0.0
    while t0 < seconds:
        chord = PROGRESSION[chord_i % len(PROGRESSION)]
        start, length = t0, CHORD_SECONDS
        for i in range(int(start * RATE), min(n, int((start + length) * RATE))):
            t = i / RATE
            e = _env(t - start, length, 0.6, 1.2)
            if e <= 0:
                continue
            v = sum(_pad(t, hz(m - 12)) for m in chord) / len(chord)
            buf[i] += v * e * 0.22
        chord_i += 1
        t0 += CHORD_SECONDS

    # アルペジオ（コードの音を順に、短く）
    step = 0
    t0 = 0.0
    while t0 < seconds:
        chord = PROGRESSION[int(t0 / CHORD_SECONDS) % len(PROGRESSION)]
        note = chord[step % len(chord)] + 12
        length = ARPEGGIO_NOTE
        for i in range(int(t0 * RATE), min(n, int((t0 + length) * RATE))):
            t = i / RATE
            e = _env(t - t0, length, 0.01, length * 0.9)
            buf[i] += math.sin(2 * math.pi * hz(note) * t) * e * 0.085
        step += 1
        t0 += ARPEGGIO_NOTE

    # 軽い残響（単純な遅延を足すだけ）
    delay = int(0.21 * RATE)
    for i in range(delay, n):
        buf[i] += buf[i - delay] * 0.22

    # ループの継ぎ目と端を整える
    fade = int(1.5 * RATE)
    for i in range(min(fade, n)):
        buf[i] *= i / fade
        buf[n - 1 - i] *= i / fade

    peak = max(1e-9, max(abs(v) for v in buf))
    scale = 0.85 / peak
    return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v * scale)) * 32767)) for v in buf)


def write(path: Path, seconds: float) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(render(seconds))
    return path


if __name__ == "__main__":
    p = write(Path("tools/video/out/bgm_sample.wav"), 30.0)
    print(f"試聴用に書き出した: {p}")
