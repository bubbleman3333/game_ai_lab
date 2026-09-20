"""ゆっくり（霊夢・魔理沙）の立ち絵を描く。口の開き具合を差し替えて口パクにする。

本物の「ゆっくり素材」は同梱されていないので、ここでコードから描いている。
**あとから本物の素材に差し替えられる**ようにしてあり、`faces/` に

    reimu_close.png  reimu_half.png  reimu_open.png
    marisa_close.png marisa_half.png marisa_open.png

を置くと、描画のかわりにそれを使う（`load_or_draw`）。

座標は 1 枚 `SIZE` 四方の中で決め打ち。大きさは呼ぶ側で決める。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .png import Canvas, Color, hex_color

SIZE = 320

SKIN = hex_color("#FBE2C4")
SKIN_SHADOW = hex_color("#EEC9A2")
EYE = hex_color("#2A1F1A")
EYE_LIGHT = hex_color("#FFFFFF")
MOUTH = hex_color("#7A2E2E")
REIMU_HAIR = hex_color("#3B2B24")
REIMU_RIBBON = hex_color("#D8383F")
MARISA_HAIR = hex_color("#E3C450")
MARISA_HAT = hex_color("#241F2B")
MARISA_BAND = hex_color("#F0EDE6")

MOUTHS = ("close", "half", "open")


@dataclass
class Sprite:
    """色と不透明度を一緒に持つ小さな絵。"""

    canvas: Canvas
    mask: bytearray

    @classmethod
    def new(cls, size: int = SIZE) -> "Sprite":
        return cls(Canvas(size, size, (0, 0, 0)), bytearray(size * size))

    def _mask_set(self, shape, *args) -> None:
        """同じ図形を不透明度のほうにも塗る（白 = 不透明）。"""
        tmp = Canvas(self.canvas.width, self.canvas.height, (0, 0, 0))
        shape(tmp, *args, (255, 255, 255))
        for i in range(len(self.mask)):
            v = tmp.buf[i * 3]
            if v:
                self.mask[i] = max(self.mask[i], v)

    def ellipse(self, cx, cy, rx, ry, color: Color) -> None:
        # 色はくっきり（aa=False）、不透明度だけなめらかにする。黒い滲みを出さないため
        self.canvas.fill_ellipse(cx, cy, rx, ry, color, aa=False)
        self._mask_set(Canvas.fill_ellipse, cx, cy, rx, ry)

    def circle(self, cx, cy, r, color: Color) -> None:
        self.ellipse(cx, cy, r, r, color)

    def poly(self, pts, color: Color) -> None:
        self.canvas.fill_poly(pts, color)
        self._mask_set(Canvas.fill_poly, pts)

    def rect(self, x, y, w, h, color: Color) -> None:
        self.canvas.fill_rect(x, y, w, h, color)
        self._mask_set(Canvas.fill_rect, x, y, w, h)


def _mouth(s: Sprite, kind: str) -> None:
    """口。close→線、half→小さく開く、open→大きく開く。"""
    cx, cy = 160, 236
    if kind == "close":
        s.rect(cx - 16, cy - 2, 32, 5, MOUTH)
    elif kind == "half":
        s.ellipse(cx, cy, 16, 11, MOUTH)
    else:
        s.ellipse(cx, cy, 21, 20, MOUTH)


def _face_base(s: Sprite) -> None:
    """顔と目。両キャラ共通。"""
    s.ellipse(160, 178, 116, 106, SKIN)
    s.ellipse(160, 246, 96, 44, SKIN_SHADOW)  # あごのあたりを少し暗く
    s.ellipse(160, 240, 92, 40, SKIN)
    for ex in (112, 208):
        s.ellipse(ex, 186, 23, 31, EYE)
        s.circle(ex + 7, 176, 7, EYE_LIGHT)


def draw_reimu(mouth: str) -> Sprite:
    s = Sprite.new()
    s.ellipse(160, 150, 132, 116, REIMU_HAIR)  # 髪（顔より一回り大きく、上にずらす）
    s.ellipse(96, 240, 30, 62, REIMU_HAIR)  # 横の髪
    s.ellipse(224, 240, 30, 62, REIMU_HAIR)
    _face_base(s)
    # 赤いリボン（頭の左上）
    s.poly([(60, 44), (112, 30), (108, 86), (58, 74)], REIMU_RIBBON)
    s.poly([(112, 30), (160, 20), (158, 70), (108, 86)], REIMU_RIBBON)
    s.circle(112, 56, 15, hex_color("#F0F0F0"))
    _mouth(s, mouth)
    return s


def draw_marisa(mouth: str) -> Sprite:
    s = Sprite.new()
    s.ellipse(160, 152, 134, 118, MARISA_HAIR)  # 金髪
    s.ellipse(92, 246, 32, 66, MARISA_HAIR)
    s.ellipse(228, 246, 32, 66, MARISA_HAIR)
    _face_base(s)
    # 黒い帽子（つば + 三角）
    s.ellipse(160, 74, 150, 26, MARISA_HAT)
    s.poly([(78, 74), (242, 74), (196, 4), (124, 4)], MARISA_HAT)
    s.rect(84, 58, 152, 16, MARISA_BAND)
    _mouth(s, mouth)
    return s


def load_or_draw(name: str, mouth: str, faces_dir: Path | None = None) -> Sprite:
    """`faces/<name>_<mouth>.png` があればそれを使い、無ければ描く。

    本物のゆっくり素材を使いたくなったら、そのフォルダに 6 枚置くだけでよい。
    """
    if faces_dir is not None:
        p = faces_dir / f"{name}_{mouth}.png"
        if p.exists():
            return _load_png(p)
    return draw_reimu(mouth) if name == "reimu" else draw_marisa(mouth)


def _load_png(path: Path) -> Sprite:
    """差し替え用の PNG（透過つき）を読む。デコードは ffmpeg に任せる。

    `SIZE` 四方に収まるよう縮めたうえで、中央に置く。
    """
    import subprocess

    from .ffmpeg import find_ffmpeg

    ff = find_ffmpeg()
    if ff is None:
        raise RuntimeError("立ち絵の差し替えには ffmpeg が要る")
    r = subprocess.run(
        [ff, "-v", "error", "-i", str(path),
         "-vf", f"scale={SIZE}:{SIZE}:force_original_aspect_ratio=decrease,"
                f"pad={SIZE}:{SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        capture_output=True, check=True,
    )
    raw = r.stdout
    assert len(raw) == SIZE * SIZE * 4, f"大きさが合わない: {len(raw)}"
    s = Sprite.new()
    for i in range(SIZE * SIZE):
        o = i * 4
        s.canvas.buf[i * 3:i * 3 + 3] = raw[o:o + 3]
        s.mask[i] = raw[o + 3]
    return s


def all_sprites(faces_dir: Path | None = None) -> dict[tuple[str, str], Sprite]:
    """(キャラ, 口) → 立ち絵。毎フレーム描き直さずに使い回す。"""
    return {(n, m): load_or_draw(n, m, faces_dir) for n in ("reimu", "marisa") for m in MOUTHS}


@dataclass
class Blitter:
    """立ち絵を速く重ねるための形。

    立ち絵はほとんどの画素が「完全に不透明」か「完全に透明」なので、
    不透明な横並び（run）をあらかじめ切り出しておき、重ねるときはスライス代入で一気に書く。
    半端な不透明度の画素はフチだけなので、そこだけ 1 画素ずつ混ぜる。
    素直に 1 画素ずつ処理すると 1 フレームあたり 10 万回になり、動画 1 本で終わらなくなる。
    """

    width: int
    height: int
    runs: list[tuple[int, int, bytes]]  # (y, x, その行に連続して書く RGB)
    partial: list[tuple[int, int, Color, float]]  # (x, y, 色, 不透明度)

    def blit(self, cv: Canvas, x0: int, y0: int) -> None:
        for y, x, data in self.runs:
            ty, tx = y0 + y, x0 + x
            if ty < 0 or ty >= cv.height:
                continue
            n = len(data) // 3
            if tx < 0 or tx + n > cv.width:
                continue
            o = (ty * cv.width + tx) * 3
            cv.buf[o:o + len(data)] = data
        for x, y, color, a in self.partial:
            cv.blend_px(x0 + x, y0 + y, color, a)


def compile_sprite(s: Sprite, height: int) -> Blitter:
    """立ち絵を指定の高さに縮めて、重ねやすい形にする。"""
    src = s.canvas
    scale = height / src.height
    w, h = max(1, round(src.width * scale)), height
    runs: list[tuple[int, int, bytes]] = []
    partial: list[tuple[int, int, Color, float]] = []
    for y in range(h):
        sy = min(src.height - 1, int(y / scale))
        x = 0
        while x < w:
            sx = min(src.width - 1, int(x / scale))
            a = s.mask[sy * src.width + sx]
            if a >= 250:  # 不透明なところは、続く限りまとめる
                start, chunk = x, bytearray()
                while x < w:
                    sx = min(src.width - 1, int(x / scale))
                    if s.mask[sy * src.width + sx] < 250:
                        break
                    o = (sy * src.width + sx) * 3
                    chunk += src.buf[o:o + 3]
                    x += 1
                runs.append((y, start, bytes(chunk)))
            else:
                if a > 6:  # ほぼ透明な画素は捨てる（見えないので）
                    o = (sy * src.width + sx) * 3
                    partial.append((x, y, (src.buf[o], src.buf[o + 1], src.buf[o + 2]), a / 255.0))
                x += 1
    return Blitter(w, h, runs, partial)


def compile_all(height: int, faces_dir: Path | None = None) -> dict[tuple[str, str], Blitter]:
    """(キャラ, 口) → 重ねる準備が済んだ立ち絵。"""
    return {k: compile_sprite(v, height) for k, v in all_sprites(faces_dir).items()}
