"""依存なしの PNG 書き出しと、簡単な図形描画。

Pillow を入れずに済ませるため、標準ライブラリの zlib だけで PNG を作る。
動画の素材はここで 1 枚ずつ PNG にして、あとで ffmpeg が mp4 にまとめる。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

Color = tuple[int, int, int]


def hex_color(s: str) -> Color:
    """'#31c7ef' → (49, 199, 239)。フロントの配色をそのまま使うため。"""
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


class Canvas:
    """RGB の画布。左上が (0, 0)。"""

    def __init__(self, width: int, height: int, bg: Color = (0, 0, 0)):
        self.width = width
        self.height = height
        self.buf = bytearray(bytes(bg) * (width * height))

    def fill_rect(self, x: int, y: int, w: int, h: int, color: Color) -> None:
        """はみ出した分は切り詰める。"""
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(self.width, x + w), min(self.height, y + h)
        if x1 <= x0 or y1 <= y0:
            return
        line = bytes(color) * (x1 - x0)
        for yy in range(y0, y1):
            off = (yy * self.width + x0) * 3
            self.buf[off:off + len(line)] = line

    def stroke_rect(self, x: int, y: int, w: int, h: int, color: Color, t: int = 1) -> None:
        """太さ t の枠線。"""
        self.fill_rect(x, y, w, t, color)
        self.fill_rect(x, y + h - t, w, t, color)
        self.fill_rect(x, y, t, h, color)
        self.fill_rect(x + w - t, y, t, h, color)

    def to_png(self) -> bytes:
        raw = bytearray()
        stride = self.width * 3
        for y in range(self.height):
            raw.append(0)  # フィルタなし
            raw += self.buf[y * stride:(y + 1) * stride]
        ihdr = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _chunk(b"IEND", b"")

    def save(self, path: Path | str) -> None:
        Path(path).write_bytes(self.to_png())


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


# --- 7 セグメントの数字 ---------------------------------------------------
# 漢字やアルファベットは YMM4 のテロップ側で入れる。ここは毎フレーム変わる数値だけ。
_SEGMENTS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
    "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "afgbcd",
}


def draw_number(cv: Canvas, value: int, x: int, y: int, size: int, color: Color, thick: int = 0, gap: int = 0) -> int:
    """7 セグ風の数字を描いて、描き終わった右端の x を返す。size は 1 文字の高さ。"""
    t = thick or max(2, size // 8)
    w = size // 2
    gap = gap or max(3, size // 6)
    for ch in str(value):
        segs = _SEGMENTS[ch]
        h = size // 2
        if "a" in segs: cv.fill_rect(x, y, w, t, color)
        if "b" in segs: cv.fill_rect(x + w - t, y, t, h, color)
        if "c" in segs: cv.fill_rect(x + w - t, y + h, t, h, color)
        if "d" in segs: cv.fill_rect(x, y + size - t, w, t, color)
        if "e" in segs: cv.fill_rect(x, y + h, t, h, color)
        if "f" in segs: cv.fill_rect(x, y, t, h, color)
        if "g" in segs: cv.fill_rect(x, y + h - t // 2, w, t, color)
        x += w + gap
    return x
