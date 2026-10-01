"""デスクトップに「将棋 AI」のショートカットを作る（アイコンも作る）。

    cd backend; .\\.venv\\Scripts\\python -m desktop.shogi.install_shortcut

ショートカットは backend/.venv の pythonw.exe（黒い窓を出さない Python）で `-m desktop.shogi` を起動する。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
ICON = HERE / "shogi.ico"


def make_icon(path: Path = ICON) -> None:
    """駒の形のアイコン（「王」）を描いて .ico に保存する。"""
    from PySide6.QtCore import QPointF, QRectF, Qt
    from PySide6.QtGui import QColor, QFont, QGuiApplication, QImage, QPainter, QPen, QPolygonF

    _app = QGuiApplication.instance() or QGuiApplication(sys.argv)
    size = 256
    img = QImage(size, size, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    w, h = size * 0.8, size * 0.92
    cx, cy = size / 2, size / 2
    poly = QPolygonF([QPointF(cx, cy - h / 2), QPointF(cx + w * 0.38, cy - h * 0.33), QPointF(cx + w / 2, cy + h / 2),
                      QPointF(cx - w / 2, cy + h / 2), QPointF(cx - w * 0.38, cy - h * 0.33)])
    p.setPen(QPen(QColor("#6b4a22"), 8))
    p.setBrush(QColor("#f2d9a0"))
    p.drawPolygon(poly)
    p.setPen(QColor("#1b1209"))
    p.setFont(QFont("Yu Mincho", 120, QFont.Bold))
    p.drawText(QRectF(0, size * 0.08, size, size), Qt.AlignCenter, "王")
    p.end()
    img.save(str(path))


def main() -> None:
    if not ICON.exists():
        make_icon()
    pythonw = BACKEND / ".venv" / "Scripts" / "pythonw.exe"
    ps = f"""
$desktop = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop '将棋 AI.lnk'))
$s.TargetPath = '{pythonw}'
$s.Arguments = '-m desktop.shogi'
$s.WorkingDirectory = '{BACKEND}'
$s.IconLocation = '{ICON}'
$s.Description = '将棋 AI（学習したネット + モンテカルロ木探索）'
$s.Save()
Write-Output (Join-Path $desktop '将棋 AI.lnk')
"""
    # PowerShell 5.1 はスクリプトを ANSI で読むので、日本語を含む文字列は -EncodedCommand（UTF-16）で渡す
    import base64
    enc = base64.b64encode(ps.encode("utf-16-le")).decode()
    out = subprocess.run(["powershell", "-NoProfile", "-EncodedCommand", enc], capture_output=True, text=True)
    print(out.stdout.strip() or out.stderr.strip())


if __name__ == "__main__":
    main()
