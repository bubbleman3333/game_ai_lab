r"""学習の途中の重み同士を並べて遊ばせ、連番 PNG にする（動画の素材づくり）。

「第 N 世代はすぐ死ぬが、第 M 世代は T スピンを積む」を、撮影や編集なしで作るためのもの。
同じツモ順（同じ seed）でひとり遊びをさせるので、差は AI の打ち方だけになる。

    cd backend
    .\.venv\Scripts\python -m tools.video.tetris_clip --run v3-selfplay --checkpoints ep_002750 ep_003250

出来た PNG は ffmpeg で mp4 にする（コマンドは実行の最後に表示する）。
漢字のテロップはここでは描かない。YMM4 側で載せたほうが後から直せるため。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from games.tetris import Game
from games.tetris.pieces import BOARD_HEIGHT, BOARD_WIDTH
from rl.tetris.agent import NeuralAgent
from rl.tetris.position import Position

from .png import Canvas, Color, draw_number, hex_color

PIECE_COLORS = {  # frontend/src/games/tetris/components/colors.ts と同じ
    "I": "#31c7ef", "J": "#5a65ad", "L": "#ef7921", "O": "#f7d308",
    "S": "#42b642", "T": "#ad4d9c", "Z": "#ef2029", "G": "#6b6b6b",
}
BG = (16, 18, 24)
GRID = (32, 35, 44)
FRAME = (70, 76, 92)
WHITE = (236, 239, 245)
VISIBLE_ROWS = 20  # 盤面 40 段のうち、画面に映す下 20 段


@dataclass
class Step:
    """1 手ぶんの記録。これを並べてフレームにする。"""

    colors: list[list[str]]  # colors[y][x]。y=0 が一番下
    lines: int  # ここまでに消した合計
    spin: str  # この手のスピン判定（'' なら無し）
    piece: str  # この手で置いたミノ
    cleared: int  # この手で消した段数
    over: bool


def play(agent: NeuralAgent, seed: int, max_pieces: int) -> list[Step]:
    """ひとり遊びを 1 局。1 手ごとに盤面を記録して返す。"""
    game = Game(seed=seed)
    colors = [[""] * BOARD_WIDTH for _ in range(BOARD_HEIGHT)]
    steps = [Step([r[:] for r in colors], 0, "", "", 0, False)]
    while not game.over and game.stats.pieces < max_pieces:
        c = agent.choose(Position.from_game(game))
        if c is None:
            break
        for a in c.path:
            game.apply(a)
        for x, y in c.placement.cells():
            if 0 <= y < BOARD_HEIGHT:
                colors[y][x] = c.placement.piece
        full = [y for y in range(BOARD_HEIGHT) if all(colors[y])]
        for y in reversed(full):
            del colors[y]
        while len(colors) < BOARD_HEIGHT:
            colors.append([""] * BOARD_WIDTH)
        # 自前の色盤面が、ゲーム本体の盤面とずれていないか確かめる
        for y in range(BOARD_HEIGHT):
            mine = sum(1 << x for x in range(BOARD_WIDTH) if colors[y][x])
            assert mine == game.board.rows[y], f"盤面がずれた: y={y} 手={game.stats.pieces}"
        steps.append(Step([r[:] for r in colors], game.stats.lines, c.placement.spin, c.placement.piece, len(full), game.over))
    if steps:
        steps[-1].over = True
    return steps


def draw_board(cv: Canvas, step: Step, x0: int, y0: int, cell: int, accent: Color, flash: bool) -> None:
    """盤面 1 つを描く。flash のときは枠を光らせる（T スピン・テトリスの瞬間）。"""
    w, h = BOARD_WIDTH * cell, VISIBLE_ROWS * cell
    cv.fill_rect(x0, y0, w, h, GRID if not step.over else (44, 24, 28))
    for row in range(VISIBLE_ROWS):
        y = VISIBLE_ROWS - 1 - row  # 画面の上の行ほど、盤面では上（添字が大きい）
        for x in range(BOARD_WIDTH):
            c = step.colors[y][x]
            if not c:
                continue
            px, py = x0 + x * cell, y0 + row * cell
            cv.fill_rect(px, py, cell - 1, cell - 1, hex_color(PIECE_COLORS[c]))
    cv.stroke_rect(x0 - 3, y0 - 3, w + 6, h + 6, WHITE if flash else FRAME, 3)
    draw_number(cv, step.lines, x0, y0 - 52, 40, WHITE if not flash else accent)


def render(runs: list[tuple[str, list[Step]]], out: Path, cell: int, hold: int, width: int, height: int) -> int:
    """各局を同じ長さに揃えて並べ、連番 PNG にする。短く終わった側は最後の盤面のまま止める。"""
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("frame_*.png"):
        old.unlink()
    n = max(len(s) for _, s in runs)
    bw = BOARD_WIDTH * cell
    gap = (width - bw * len(runs)) // (len(runs) + 1)
    top = (height - VISIBLE_ROWS * cell) // 2 + 20
    accents = [hex_color("#31c7ef"), hex_color("#ef7921"), hex_color("#42b642")]
    frame = 0
    for i in range(n):
        highlight = []
        for _, steps in runs:
            s = steps[min(i, len(steps) - 1)]
            live = i < len(steps)
            highlight.append(live and ((s.spin != "" and s.piece == "T" and s.cleared > 0) or s.cleared >= 4))
        for _ in range(hold):
            cv = Canvas(width, height, BG)
            for k, (_, steps) in enumerate(runs):
                s = steps[min(i, len(steps) - 1)]
                draw_board(cv, s, gap + k * (bw + gap), top, cell, accents[k % len(accents)], highlight[k])
            cv.save(out / f"frame_{frame:05d}.png")
            frame += 1
    return frame


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", default="v3-selfplay")
    p.add_argument("--checkpoints", nargs="+", default=["ep_002750", "ep_003250"])
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--max-pieces", type=int, default=250)
    p.add_argument("--cell", type=int, default=26)
    p.add_argument("--hold", type=int, default=4, help="1 手を何フレーム映すか（30fps なら 4 で約 7.5 手/秒）")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--out", default="tools/video/out/tetris")
    a = p.parse_args()

    runs = []
    for name in a.checkpoints:
        path = Path("runs/tetris") / a.run / "checkpoints" / f"{name}.pt"
        agent = NeuralAgent.load(path)
        steps = play(agent, a.seed, a.max_pieces)
        spins = sum(1 for s in steps if s.spin and s.cleared and s.piece == "T")
        quads = sum(1 for s in steps if s.cleared >= 4)
        print(f"{name}: {len(steps) - 1} 手 / 消去 {steps[-1].lines} 段 / スピン消し {spins} / テトリス {quads}")
        runs.append((name, steps))

    out = Path(a.out)
    frames = render(runs, out, a.cell, a.hold, a.width, a.height)
    print(f"\n{frames} フレームを {out} に書き出した。mp4 にするには:")
    print(f'  ffmpeg -y -framerate 30 -i "{out}/frame_%05d.png" -c:v libx264 -pix_fmt yuv420p "{out}.mp4"')


if __name__ == "__main__":
    main()
