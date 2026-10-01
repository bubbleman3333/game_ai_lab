"""将棋 AI のデスクトップアプリ。

    cd backend; .\\.venv\\Scripts\\python -m desktop.shogi
（デスクトップのショートカットからは pythonw で起動する。README を参照）
"""

import ctypes
import multiprocessing
import sys
from pathlib import Path


def main() -> None:
    # backend/ を import の起点にする（ショートカットから起動したとき、作業フォルダが違っても動くように）
    backend = Path(__file__).resolve().parents[2]
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))

    if sys.stderr is None:  # pythonw（ショートカット）で起動すると、エラーの出し先が無いのでファイルに残す
        log = backend / "logs" / "shogi_desktop.log"
        log.parent.mkdir(exist_ok=True)
        sys.stderr = sys.stdout = open(log, "a", encoding="utf-8", buffering=1)

    try:  # タスクバーで python ではなくこのアプリのアイコンを出す
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("game_ai_lab.shogi")
    except Exception:
        pass
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from .window import MainWindow

    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setApplicationName("将棋 AI")
    icon = Path(__file__).with_name("shogi.ico")
    if icon.exists():
        app.setWindowIcon(QIcon(str(icon)))
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    multiprocessing.freeze_support()  # 詰み探索の別プロセス（rl/shogi/mate.py）のため
    main()
