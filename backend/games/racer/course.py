"""コース（中心線）の読み込みと、コース上の位置の計算。Django・PyTorch に依存しない。

座標は three.js と同じ向きにそろえてある:
    x = 右、y = 上、z = 奥。長さの単位はメートル。
    向き（yaw）は「前を向くベクトルが (sin yaw, 0, cos yaw)」。yaw = 0 が +z の向き。
    運転者から見た右を向くベクトルは (-cos yaw, 0, sin yaw)。
    （右手系で上が +y・前が +z のとき、右 = 前 × 上 = -x になる。つまり画面の右はワールドの -x。
    ここを取り違えると、ハンドルを右に切ったのに画面では左へ曲がる。）
    右へ曲がると yaw は減り、左へ曲がると増える。

`shared/courses/*.json` に書かれた十数個のウェイポイントを Catmull-Rom 曲線でつなぎ、
約 1m ごとの点に並べ直す。この「並べ直した中心線」が

    - 物理（どこが道で、地面の高さはいくつか）
    - AI の観測（この先のコースがどう曲がっているか）
    - 3D の道メッシュ・ガードレール・景色の配置

のすべての土台になる。だから並べ直しの結果が Python 版と TypeScript 版で 1 つでも違うと、
学習した AI がブラウザで違う走りをしてしまう。
TypeScript 版（frontend/src/games/racer/engine/course.ts）はここと同じ式・同じ順番で計算し、
`python -m games.racer.fixtures` が作るテストデータで一致を確かめている。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

COURSES_DIR = Path(__file__).resolve().parents[3] / "shared" / "courses"

SUB = 16  # ウェイポイント 1 区間を何分割して曲線を近似するか
SPACING = 1.0  # 並べ直したあとの点の間隔（m）の目安。実際はコース 1 周を割り切る値になる
BANK_GAIN = 6.0  # 曲がり具合 → 道の傾き（バンク）。大きいほどコーナーが深く傾く
BANK_MAX = 0.28  # 自動でつく傾きの上限（ラジアン。約 20 度）

# 路面の種類。physics.py と course.ts でも同じ番号を使う
KIND_NORMAL = 0
KIND_BOOST = 1  # 加速パネル
KIND_DIRT = 2  # 砂・土。曲がりにくく加速も鈍る
KIND_RAMP = 3  # ジャンプ台。地面そのものが坂になっていて、終わりが崖になっている
KIND_GAP = 4  # 道が途切れている。飛び越えられないと落ちる
KIND_BY_NAME = {"normal": KIND_NORMAL, "boost": KIND_BOOST, "dirt": KIND_DIRT,
                "ramp": KIND_RAMP, "gap": KIND_GAP}

DEFAULT_RAMP_LENGTH = 26.0
DEFAULT_RAMP_HEIGHT = 6.0


def _spline(v0: float, v1: float, v2: float, v3: float,
            t0: float, t1: float, t2: float, t3: float, t: float) -> float:
    """p1 と p2 の間を、前後の点 p0・p3 も見ながら滑らかにつなぐ（Catmull-Rom 曲線）。

    t0〜t3 は各点の「節の位置」。点と点の距離の平方根を間隔にすると（centripetal 型）、
    ウェイポイントの間隔がばらばらでも曲線が外へ膨らまない。
    ふつうの Catmull-Rom だと、短い区間と長い区間が隣り合ったところで道が大きく膨らみ、
    半径 1m のような走れないコーナーができてしまう。
    """
    a1 = ((t1 - t) * v0 + (t - t0) * v1) / (t1 - t0)
    a2 = ((t2 - t) * v1 + (t - t1) * v2) / (t2 - t1)
    a3 = ((t3 - t) * v2 + (t - t2) * v3) / (t3 - t2)
    b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0)
    b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1)
    return ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1)


def _knot_gap(a: dict, b: dict) -> float:
    """節の間隔 = 2 点の距離の平方根。"""
    d = math.sqrt((b["x"] - a["x"]) ** 2 + (b.get("y", 0.0) - a.get("y", 0.0)) ** 2
                  + (b["z"] - a["z"]) ** 2)
    return math.sqrt(max(d, 1e-6))


def _wrap_angle(a: np.ndarray) -> np.ndarray:
    """角度を -π〜π に収める。"""
    return (a + math.pi) % (2 * math.pi) - math.pi


@dataclass
class Course:
    """1m ごとに並べ直した中心線。配列はすべて長さ n で、最後の点の次は最初の点（輪になっている）。"""

    id: str
    name: str
    theme: str
    description: str
    laps: int
    x: np.ndarray  # 中心線の位置
    y: np.ndarray  # 道の高さ（ジャンプ台の坂を反映済み）。gap の区間には道がない（kind で判断する）
    z: np.ndarray
    width: np.ndarray  # 道幅（m）。走れるのは中心から ±width/2
    bank: np.ndarray  # 道の傾き（ラジアン）。正なら「運転者から見て右側が下がる」＝右コーナーの向き
    heading: np.ndarray  # 進行方向の yaw
    kind: np.ndarray  # 路面の種類（KIND_*）
    safe: np.ndarray  # その点以前で道が途切れていない点の番号（落ちたときの復帰先）
    spacing: float  # 点の間隔（m）
    length: float  # 1 周の長さ（m）

    @property
    def n(self) -> int:
        return len(self.x)

    def at(self, idx: np.ndarray) -> tuple[np.ndarray, ...]:
        """点の番号から (x, y, z, width, bank, heading, kind) を取り出す。"""
        return (self.x[idx], self.y[idx], self.z[idx], self.width[idx],
                self.bank[idx], self.heading[idx], self.kind[idx])

    def nearest(self, px: np.ndarray, pz: np.ndarray, prev: np.ndarray,
                back: int = 8, fwd: int = 20) -> np.ndarray:
        """今いる点の番号。前回の番号の近くだけを調べる（コースが近くで交差していても迷わない）。"""
        offs = np.arange(-back, fwd + 1)
        cand = (prev[:, None] + offs[None, :]) % self.n
        dx = px[:, None] - self.x[cand]
        dz = pz[:, None] - self.z[cand]
        best = np.argmin(dx * dx + dz * dz, axis=1)
        return cand[np.arange(len(px)), best]

    def nearest_global(self, px: np.ndarray, pz: np.ndarray) -> np.ndarray:
        """コース全体から一番近い点を探す（スタート時・コース復帰のときだけ使う）。"""
        dx = px[:, None] - self.x[None, :]
        dz = pz[:, None] - self.z[None, :]
        return np.argmin(dx * dx + dz * dz, axis=1)


def _polyline(wps: list[dict], default_width: float) -> tuple[list[tuple[float, ...]], list[int]]:
    """ウェイポイントを曲線でつなぎ、細かい折れ線にする。

    戻り値: (点の列 [(x, y, z, 幅, 追加のバンク), ...], ウェイポイント i が折れ線の何番目か)
    """
    m = len(wps)
    pts: list[tuple[float, ...]] = []
    wp_index: list[int] = []
    for i in range(m):
        p0, p1, p2, p3 = wps[(i - 1) % m], wps[i], wps[(i + 1) % m], wps[(i + 2) % m]
        t0 = 0.0
        t1 = t0 + _knot_gap(p0, p1)
        t2 = t1 + _knot_gap(p1, p2)
        t3 = t2 + _knot_gap(p2, p3)
        wp_index.append(len(pts))
        for k in range(SUB):
            f = k / SUB
            t = t1 + (t2 - t1) * f
            x = _spline(p0["x"], p1["x"], p2["x"], p3["x"], t0, t1, t2, t3, t)
            y = _spline(p0.get("y", 0.0), p1.get("y", 0.0), p2.get("y", 0.0), p3.get("y", 0.0),
                        t0, t1, t2, t3, t)
            z = _spline(p0["z"], p1["z"], p2["z"], p3["z"], t0, t1, t2, t3, t)
            # 幅とバンクは曲線にする必要がないので、素直に直線で混ぜる
            w1, w2 = p1.get("width", default_width), p2.get("width", default_width)
            b1, b2 = p1.get("bank", 0.0), p2.get("bank", 0.0)
            pts.append((x, y, z, w1 + (w2 - w1) * f, b1 + (b2 - b1) * f))
    return pts, wp_index


def _resample(pts: list[tuple[float, ...]]) -> tuple[np.ndarray, float, float, list[float]]:
    """折れ線を、等間隔（約 SPACING m）の点に並べ直す。

    戻り値: (点の配列 (n, 5), 間隔, 1 周の長さ, 折れ線の各点までの距離)
    """
    m = len(pts)
    cum = [0.0]
    for i in range(m):
        a, b = pts[i], pts[(i + 1) % m]
        d = math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2)
        cum.append(cum[-1] + d)
    total = cum[-1]
    n = max(8, int(round(total / SPACING)))
    spacing = total / n
    out = np.zeros((n, 5))
    j = 0
    for k in range(n):
        d = k * spacing
        while j < m - 1 and cum[j + 1] <= d:
            j += 1
        seg = cum[j + 1] - cum[j]
        t = (d - cum[j]) / seg if seg > 1e-9 else 0.0
        a, b = pts[j], pts[(j + 1) % m]
        for c in range(5):
            out[k, c] = a[c] + (b[c] - a[c]) * t
    return out, spacing, total, cum


def _headings(x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """各点での進行方向。前後の点を結んだ向き（中央差分）を使う。"""
    nxt = np.roll(x, -1), np.roll(z, -1)
    prv = np.roll(x, 1), np.roll(z, 1)
    return np.arctan2(nxt[0] - prv[0], nxt[1] - prv[1])


def _apply_features(data: dict, course_len: float, spacing: float, n: int,
                    wp_dist: list[float], kind: np.ndarray, y: np.ndarray) -> None:
    """コースの仕掛け（加速パネル・砂・ジャンプ台・途切れ）を、並べ直した中心線に塗る。

    指定のしかた（shared/courses/*.json の "features"）:
        from    どのウェイポイントから始まるか
        offset  そこから何 m 進んだところから始まるか（省略すると 0）
        to      どのウェイポイントまでか            ┐ どちらかを書く
        length  始まりから何 m ぶんか               ┘
    あとに書いたものが先に書いたものを上書きする。
    """
    dist = np.arange(n) * spacing
    for f in data.get("features", []):
        kind_id = KIND_BY_NAME.get(f["kind"])
        if kind_id is None:
            raise ValueError(f"知らない仕掛けです: {f['kind']}")
        d0 = wp_dist[f["from"]] + f.get("offset", 0.0)
        if "length" in f:
            span = float(f["length"])
        elif "to" in f:
            span = (wp_dist[f["to"]] - d0) % course_len
        elif kind_id == KIND_RAMP:
            span = DEFAULT_RAMP_LENGTH
        else:
            raise ValueError(f"{f['kind']}: 'to' か 'length' が要ります")
        if span <= 0:
            continue
        rel = (dist - d0) % course_len
        inside = rel <= span
        kind[inside] = kind_id
        if kind_id == KIND_RAMP:
            # ジャンプ台は地面そのものを坂にする。坂の終わりは崖になっていて、
            # 速く走るほど（坂で得た上向きの速さぶん）遠くまで飛ぶ
            height = float(f.get("height", DEFAULT_RAMP_HEIGHT))
            y[inside] += height * (rel[inside] / span)


def build(data: dict) -> Course:
    """コースの JSON（読み込み済み）から Course を組み立てる。"""
    wps = data["waypoints"]
    if len(wps) < 4:
        raise ValueError("ウェイポイントは 4 個以上必要です（曲線をつなぐのに前後の点を使うため）")
    default_width = float(data.get("width", 16.0))
    pts, wp_index = _polyline(wps, default_width)
    arr, spacing, total, cum = _resample(pts)
    x, y, z, width, bank_extra = (arr[:, c].copy() for c in range(5))
    n = len(x)

    heading = _headings(x, z)
    # 曲がり具合（1m あたりの向きの変わり方）から、コーナーの傾きを自動でつける。
    # 右へ曲がるときは heading が減る（curv < 0）ので、符号を反転して
    # 「右コーナーでは右側（＝内側）が下がる」ようにする
    curv = _wrap_angle(np.roll(heading, -1) - np.roll(heading, 1)) / (2 * spacing)
    auto = np.clip(-curv * BANK_GAIN, -BANK_MAX, BANK_MAX)
    bank = auto - np.sign(curv) * np.abs(bank_extra)

    kind = np.zeros(n, dtype=np.int64)
    wp_dist = [cum[i] for i in wp_index]
    _apply_features(data, total, spacing, n, wp_dist, kind, y)

    # 落ちたときに戻る場所: その点から後ろへたどって、最初に道がある点
    safe = np.zeros(n, dtype=np.int64)
    last = int(np.argmax(kind != KIND_GAP))  # どこか 1 つは道があるはずなので、そこから始める
    for _ in range(2):  # 輪になっているので 2 周すれば全部埋まる
        for k in range(n):
            if kind[k] != KIND_GAP:
                last = k
            safe[k] = last

    return Course(
        id=data["id"], name=data.get("name", data["id"]), theme=data.get("theme", "meadow"),
        description=data.get("description", ""), laps=int(data.get("laps", 3)),
        x=x, y=y, z=z, width=width, bank=bank, heading=heading, kind=kind, safe=safe,
        spacing=spacing, length=total,
    )


def course_ids() -> list[str]:
    """使えるコースの一覧（shared/courses/*.json のファイル名順）。"""
    return sorted(p.stem for p in COURSES_DIR.glob("*.json"))


@lru_cache(maxsize=None)
def load(course_id: str) -> Course:
    """コースを読み込む（一度読んだら使い回す）。"""
    path = COURSES_DIR / f"{course_id}.json"
    if not path.exists():
        raise ValueError(f"コース '{course_id}' がありません（{COURSES_DIR}）")
    return build(json.loads(path.read_text(encoding="utf-8")))
