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


    def blend_px(self, x: int, y: int, color: Color, a: float) -> None:
        """1 ピクセルを不透明度 a (0〜1) で重ねる。フチのギザギザを減らすのに使う。"""
        if a <= 0 or x < 0 or y < 0 or x >= self.width or y >= self.height:
            return
        if a >= 1:
            o = (y * self.width + x) * 3
            self.buf[o:o + 3] = bytes(color)
            return
        o = (y * self.width + x) * 3
        for i in range(3):
            self.buf[o + i] = int(self.buf[o + i] * (1 - a) + color[i] * a)

    def fill_ellipse(self, cx: float, cy: float, rx: float, ry: float, color: Color,
                     aa: bool = True) -> None:
        """楕円。aa=True なら境界を 1px ぶんなめらかにする。

        透過つきの絵を作るときは、色は aa=False（くっきり）、不透明度だけ aa=True にする。
        そうしないと、境界の色が背景と混ざって黒い滲みになる。
        """
        if rx <= 0 or ry <= 0:
            return
        for y in range(max(0, int(cy - ry - 1)), min(self.height, int(cy + ry + 2))):
            for x in range(max(0, int(cx - rx - 1)), min(self.width, int(cx + rx + 2))):
                d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2
                if d <= 1.0:
                    self.blend_px(x, y, color, 1.0)
                elif aa and d <= 1.25:
                    self.blend_px(x, y, color, (1.25 - d) / 0.25)

    def fill_circle(self, cx: float, cy: float, r: float, color: Color, aa: bool = True) -> None:
        self.fill_ellipse(cx, cy, r, r, color, aa)

    def fill_poly(self, pts: list[tuple[float, float]], color: Color) -> None:
        """凸凹どちらでもよい多角形（走査線で塗る）。三角の髪やリボンに使う。"""
        if len(pts) < 3:
            return
        ys = [p[1] for p in pts]
        for y in range(max(0, int(min(ys))), min(self.height, int(max(ys)) + 1)):
            xs = []
            for i in range(len(pts)):
                x1, y1 = pts[i]
                x2, y2 = pts[(i + 1) % len(pts)]
                if (y1 <= y < y2) or (y2 <= y < y1):
                    xs.append(x1 + (y + 0.5 - y1) * (x2 - x1) / (y2 - y1))
            xs.sort()
            for i in range(0, len(xs) - 1, 2):
                self.fill_rect(int(xs[i]), y, max(1, int(xs[i + 1]) - int(xs[i])), 1, color)

    def paste(self, other: "Canvas", x0: int, y0: int, mask: bytearray | None = None) -> None:
        """別の画布を重ねる。mask は 0〜255 の不透明度（画素ごと）。"""
        for y in range(other.height):
            ty = y0 + y
            if ty < 0 or ty >= self.height:
                continue
            for x in range(other.width):
                tx = x0 + x
                if tx < 0 or tx >= self.width:
                    continue
                i = y * other.width + x
                a = 1.0 if mask is None else mask[i] / 255.0
                if a <= 0:
                    continue
                o = i * 3
                self.blend_px(tx, ty, (other.buf[o], other.buf[o + 1], other.buf[o + 2]), a)

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
