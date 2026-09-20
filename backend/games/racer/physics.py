"""レースの物理（numpy で N 台を同時に計算する）。Django・PyTorch に依存しない。

座標と向きの決まりは course.py の冒頭に書いてある（x・y・z の向きと、運転者から見た右の求め方）。
TypeScript 版（frontend/src/games/racer/engine/physics.ts）はここと同じ式・同じ順番で計算する。
式や定数を変えたら両方を直し、`python -m games.racer.fixtures` でテストデータを作り直す。

考え方
------
3D に見えるが、計算しているのは「平面の上を走る車 + 高さ」だけ。車体の変形も、タイヤ 4 本ぶんの
サスペンションも計算しない。そのぶん numpy で何百台も同時に進められるので、強化学習が回せる。

ジャンプは特別扱いしていない。接地しているあいだ、車は
「地面の高さの変わりぶん」をそのまま上向きの速度として持つ。
だから坂をのぼりきったところ（丘の頂上・ジャンプ台の終わり）では、地面が下がるのに上向きの速度が
残っているので、そのまま宙に浮く。速く走るほど上向きの速度が大きくなり、遠くまで飛ぶ。

空中ではステアが前輪ではなく機体の回転になる（`air_control`）。1 回転させてから着地すると
ブーストがもらえる（トリック）。向きがずれたまま着地すれば、そのぶん横滑りする。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import course as CO

CARS_DIR = Path(__file__).resolve().parents[3] / "shared" / "cars"

DT = 1 / 60  # 1 ステップの時間（秒）
GRAVITY = 26.0  # 重力（m/s²）。本物より強めにして、飛んでいる時間を気持ちよくしている
GAP_DROP = 200.0  # 道が途切れている区間の「地面」をどれだけ下に置くか（要するに底なし）

STEER_REF = 3.0  # この速さ（m/s）以下ではステアが弱くなる（止まったまま回らないように）
# 横方向にどれだけ踏ん張れるか（m/s²）。速いほど曲がれる角速度がこれで頭打ちになる。
# これが無いと、時速 144km で半径 10m を横滑りゼロで曲がれてしまい、
# 「ハンドルを切った瞬間にその場で向きが変わる」置きにくい挙動になる
LAT_BASE = 12.0
LAT_PER_GRIP = 0.9  # 車の grip 1 あたりの上乗せ
BRAKE_SLIDE = 0.55  # ブレーキ中は横グリップがこの倍率になる（ブレーキで滑らせられる）
ALIGN = 1.0  # 滑っているとき、車の向きが進行方向へ戻る速さ（1/秒）
REVERSE_MAX = 9.0  # 後退の最高速
BOOST_TIME = 1.8  # 加速パネルを踏んだときのブーストの長さ（秒）
BOOST_ACCEL = 26.0  # ブースト中の追加加速（m/s²）
BOOST_VMAX = 1.3  # ブースト中は最高速がこの倍率まで上がる
TRICK_BOOST = 0.8  # 空中で半回転して着地するごとにもらえるブーストの秒数
TRICK_TURN = math.pi  # トリック 1 回ぶんの角度（半回転）

DIRT_GRIP = 0.45  # 砂の上での横グリップの倍率
DIRT_ACCEL = 0.72  # 砂の上での加速の倍率
BANK_GRIP = 1.2  # 道の傾き（バンク）が横グリップをどれだけ増やすか

AIR_LAT_DRAG = 0.4  # 空中で横滑りが減る速さ
WALL_DRAG = 0.6  # 壁（コースの端）を擦っているあいだの減速（1 秒でだいたい半分の速さになる）
GROUND_EPS = 0.02  # これだけ地面に近ければ接地とみなす
LAND_REACH = 3.0  # 地面よりこれ以上下にいたら接地しない（落下中に道へ吸い上げられないように）
SLOPE_VY_MIN = 1.0  # 坂で得られる上向きの速さの下限（止まっていても段差で少しは持ち上がる）
FALL_LIMIT = 10.0  # 道の高さよりこれだけ下まで落ちたらコースに戻す
RESPAWN_TIME = 1.4  # 戻ってから操作を受け付けるまでの時間（秒）
RESPAWN_BACK = 45.0  # 落ちた場所から何 m 手前に戻すか（助走がとれる距離）
RESPAWN_SPEED = 8.0  # 戻ったときの速さ
JUMP_COOLDOWN = 0.35  # 続けてジャンプできない時間（秒）


@dataclass(frozen=True)
class Car:
    """車の性能。見た目とは切り離してある（見た目は frontend の scene/carDesigns.ts）。"""

    id: str
    name: str
    description: str
    accel: float  # アクセルの加速（m/s²）
    brake: float  # ブレーキの減速（m/s²）
    vmax: float  # 最高速（m/s）
    grip: float  # 横グリップ。大きいほど滑らない
    steer: float  # ステアの最大角速度（ラジアン/秒）
    jump: float  # 自分で跳ぶときの上向きの速さ（m/s）
    air_control: float  # 空中での回転の速さ（ラジアン/秒）
    drag: float  # 空気抵抗


def car_ids() -> list[str]:
    return sorted(p.stem for p in CARS_DIR.glob("*.json"))


@lru_cache(maxsize=None)
def load_car(car_id: str) -> Car:
    path = CARS_DIR / f"{car_id}.json"
    if not path.exists():
        raise ValueError(f"車 '{car_id}' がありません（{CARS_DIR}）")
    d = json.loads(path.read_text(encoding="utf-8"))
    return Car(id=d["id"], name=d.get("name", d["id"]), description=d.get("description", ""),
               accel=d["accel"], brake=d["brake"], vmax=d["vmax"], grip=d["grip"],
               steer=d["steer"], jump=d["jump"], air_control=d["air_control"], drag=d["drag"])


FIELDS = ("x", "y", "z", "vx", "vy", "vz", "yaw", "seg", "prog", "lap",
          "on_ground", "boost", "spin", "air", "cool", "respawn")


@dataclass
class State:
    """N 台ぶんの状態。すべて形 (N,) の float 配列。"""

    x: np.ndarray  # 位置
    y: np.ndarray
    z: np.ndarray
    vx: np.ndarray  # 速度（ワールド座標）
    vy: np.ndarray
    vz: np.ndarray
    yaw: np.ndarray  # 車の向き
    seg: np.ndarray  # 今いる中心線の点の番号（整数値を float で持つ）
    prog: np.ndarray  # コースを進んだ距離（周回ぶんを足した累計。m）
    lap: np.ndarray  # 今までに終えた周回の数。戻ってもう一度線を越えても増えない
    on_ground: np.ndarray  # 接地しているか（1 / 0）
    boost: np.ndarray  # ブーストの残り時間（秒）
    spin: np.ndarray  # 空中で回した角度の合計（ラジアン。着地でトリック判定に使う）
    air: np.ndarray  # 空中にいる時間（秒）
    cool: np.ndarray  # 次に跳べるまでの時間（秒）
    respawn: np.ndarray  # コース復帰の残り時間（秒）。0 より大きいあいだは操作を受け付けない

    @classmethod
    def zeros(cls, n: int) -> "State":
        return cls(*(np.zeros(n) for _ in FIELDS))

    def copy(self) -> "State":
        return State(*(getattr(self, f).copy() for f in FIELDS))


def reset(s: State, mask: np.ndarray, course: CO.Course, start_seg: np.ndarray | None = None,
          lane: np.ndarray | None = None, speed: np.ndarray | None = None) -> None:
    """mask の車をコース上に置く。start_seg を渡すとその点から、渡さなければスタート地点から。

    lane は中心線からの左右のずれ（m）。複数台を横に並べてスタートさせるときに使う。
    speed を渡すと、その速さでコースの向きへ走り出した状態にする（学習で途中から始めるとき用）。
    """
    k = int(mask.sum())
    if not k:
        return
    idx = (np.zeros(k, dtype=np.int64) if start_seg is None else start_seg.astype(np.int64) % course.n)
    off = np.zeros(k) if lane is None else lane
    sp = np.zeros(k) if speed is None else speed
    cx, cy, cz = course.x[idx], course.y[idx], course.z[idx]
    head = course.heading[idx]
    rx, rz = -np.cos(head), np.sin(head)
    s.x[mask] = cx + rx * off
    s.y[mask] = cy
    s.z[mask] = cz + rz * off
    s.yaw[mask] = head
    s.seg[mask] = idx
    s.vx[mask] = np.sin(head) * sp
    s.vz[mask] = np.cos(head) * sp
    for f in ("vy", "prog", "lap", "boost", "spin", "air", "cool", "respawn"):
        getattr(s, f)[mask] = 0.0
    s.on_ground[mask] = 1.0


def _respawn(s: State, mask: np.ndarray, course: CO.Course) -> None:
    """落ちた車を、道のある手前の地点に戻す。"""
    k = int(mask.sum())
    if not k:
        return
    back = int(round(RESPAWN_BACK / course.spacing))
    idx = course.safe[(s.seg[mask].astype(np.int64) - back) % course.n]
    head = course.heading[idx]
    s.x[mask] = course.x[idx]
    s.y[mask] = course.y[idx]
    s.z[mask] = course.z[idx]
    s.yaw[mask] = head
    s.seg[mask] = idx
    s.vx[mask] = np.sin(head) * RESPAWN_SPEED
    s.vy[mask] = 0.0
    s.vz[mask] = np.cos(head) * RESPAWN_SPEED
    s.on_ground[mask] = 1.0
    s.boost[mask] = 0.0
    s.spin[mask] = 0.0
    s.air[mask] = 0.0
    s.respawn[mask] = RESPAWN_TIME


def _along(course: CO.Course, idx: np.ndarray, x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """中心線の点 idx から前後にどれだけずれているか（点の番号を単位にした値、だいたい -0.5〜0.5）。

    中心線の点は 1m ごとにしか無いので、「今どの点にいるか」だけで高さを決めると、
    点をまたぐ瞬間だけ地面が段差になり、車が跳ねてしまう。前後のずれも見て地面をつなぐ。
    """
    head = course.heading[idx]
    return ((x - course.x[idx]) * np.sin(head) + (z - course.z[idx]) * np.cos(head)) / course.spacing


def _ground_height(course: CO.Course, idx: np.ndarray, along: np.ndarray) -> np.ndarray:
    """その位置の地面の高さ。点と点のあいだは直線でつなぐ。

    道が途切れている区間（gap）には、ずっと下まで地面がない。
    """
    # 車がいる側の隣の点とのあいだで混ぜる。前の点とだけ混ぜると、点をまたぐ瞬間に
    # 高さが飛んでしまい（坂の傾きが点ごとに違うため）、平らな下り坂でも車が跳ねる
    side = np.where(along >= 0, 1, -1)
    nb = (idx + side) % course.n
    y = course.y[idx] + (course.y[nb] - course.y[idx]) * np.abs(along)
    return np.where(course.kind[idx] == CO.KIND_GAP, y - GAP_DROP, y)


def step(s: State, car: Car, course: CO.Course,
         throttle: np.ndarray, steer: np.ndarray, jump: np.ndarray) -> dict:
    """1 ステップ（1/60 秒）進める。

    throttle: -1〜1（1 = 全開、-1 = ブレーキ / 後退）
    steer:    -1〜1（1 = 右。運転者から見た右で、画面でも右へ曲がる）
    jump:     -1〜1（0.5 を超えたら跳ぶ）

    戻り値は、その 1 ステップで起きたこと（どれも形 (N,) の配列）:
        landed  着地した      tricks  着地したときの回転数
        fell    落ちて戻った   lapped  スタートラインを越えた
        hit     壁に当たった
    """
    n = course.n
    idx0 = s.seg.astype(np.int64)
    along0 = _along(course, idx0, s.x, s.z)
    ground0 = _ground_height(course, idx0, along0)
    kind = course.kind[idx0]
    bank = course.bank[idx0]

    # --- 復帰中は操作を受け付けない ------------------------------------------
    waiting = s.respawn > 0
    s.respawn = np.maximum(0.0, s.respawn - DT)
    th = np.where(waiting, 0.0, throttle)
    st = np.where(waiting, 0.0, steer)
    jp = np.where(waiting, -1.0, jump)

    # --- 速度を「前後」と「横」に分ける --------------------------------------
    fx, fz = np.sin(s.yaw), np.cos(s.yaw)
    rx, rz = -np.cos(s.yaw), np.sin(s.yaw)
    vlong = s.vx * fx + s.vz * fz
    vlat = s.vx * rx + s.vz * rz

    grounded = s.on_ground > 0.5
    dirt = kind == CO.KIND_DIRT
    grip_mul = np.where(dirt, DIRT_GRIP, 1.0) * (1.0 + np.abs(bank) * BANK_GRIP)
    accel_mul = np.where(dirt, DIRT_ACCEL, 1.0)

    # --- ブースト -------------------------------------------------------------
    on_pad = grounded & (kind == CO.KIND_BOOST)
    s.boost = np.where(on_pad, BOOST_TIME, s.boost)
    boosting = s.boost > 0
    s.boost = np.maximum(0.0, s.boost - DT)

    # --- 向きを変える ---------------------------------------------------------
    # 接地中は前輪で曲がる。ただし「曲がれる速さ」はグリップで頭打ちになる:
    # 速く走るほど、同じ角速度で曲がるのに必要な横方向の加速度が大きくなるため。
    # 後退中は逆向き。空中は機体ごと回る
    lat_accel = (LAT_BASE + LAT_PER_GRIP * car.grip) * grip_mul
    max_turn = lat_accel / np.maximum(np.abs(vlong), 1.0)
    speed_ref = np.clip(np.abs(vlong) / STEER_REF, 0.0, 1.0)
    turn_ground = st * np.minimum(car.steer, max_turn) * speed_ref * np.where(vlong < 0, -1.0, 1.0)
    turn_air = st * car.air_control
    turn = np.where(grounded, turn_ground, turn_air)
    # 滑っているあいだは、車の向きがじわっと進行方向へ戻る（立て直しやすくする）
    slip_angle = np.arctan2(vlat, np.maximum(np.abs(vlong), 1.0))
    align = np.where(grounded, ALIGN * slip_angle, 0.0)
    s.yaw = s.yaw - (turn + align) * DT
    s.spin = np.where(grounded, s.spin, s.spin - turn * DT)

    # --- 前後の速さ -----------------------------------------------------------
    drive = np.where(th >= 0, th * car.accel * accel_mul, th * car.brake)
    vlong = vlong + np.where(grounded, drive, 0.0) * DT
    vlong = vlong + np.where(grounded & boosting, BOOST_ACCEL, 0.0) * DT
    vlong = vlong - car.drag * vlong * DT
    vmax = car.vmax * np.where(boosting, BOOST_VMAX, 1.0)
    vlong = np.clip(vlong, -REVERSE_MAX, vmax)

    # --- 横滑り ---------------------------------------------------------------
    # 接地中はグリップで横滑りが減る。減りきらずに残ったぶんがドリフトになる
    braking = th < -0.5  # ブレーキを踏むと横グリップが落ちて、滑らせて向きを変えられる
    keep_ground = np.maximum(0.0, 1.0 - car.grip * grip_mul * np.where(braking, BRAKE_SLIDE, 1.0) * DT)
    keep_air = max(0.0, 1.0 - AIR_LAT_DRAG * DT)
    vlat = vlat * np.where(grounded, keep_ground, keep_air)

    # --- ワールド座標の速度に戻す（向きを変えたあとの前後左右で組み立てる） ----
    fx, fz = np.sin(s.yaw), np.cos(s.yaw)
    rx, rz = -np.cos(s.yaw), np.sin(s.yaw)
    s.vx = vlong * fx + vlat * rx
    s.vz = vlong * fz + vlat * rz

    # --- 自分で跳ぶ -----------------------------------------------------------
    can_jump = grounded & (jp > 0.5) & (s.cool <= 0)
    s.vy = np.where(can_jump, car.jump, s.vy)
    s.cool = np.where(can_jump, JUMP_COOLDOWN, np.maximum(0.0, s.cool - DT))

    # --- 上下 -----------------------------------------------------------------
    s.vy = s.vy - GRAVITY * DT
    s.x = s.x + s.vx * DT
    s.y = s.y + s.vy * DT
    s.z = s.z + s.vz * DT

    # --- 移動後のコース上の位置 ------------------------------------------------
    idx = course.nearest(s.x, s.z, idx0)
    s.seg = idx.astype(np.float64)
    cx, cz = course.x[idx], course.z[idx]
    chead, cwidth = course.heading[idx], course.width[idx]
    along = _along(course, idx, s.x, s.z)
    ground = _ground_height(course, idx, along)

    # --- 接地したか -----------------------------------------------------------
    # 地面より十分下にいるときは接地させない。そうしないと、道が途切れた区間に落ちた車が
    # そのまま前へ流れて向こう側の道の下に入ったとき、いきなり道の上へ引き上げられてしまう
    now_ground = (s.y <= ground + GROUND_EPS) & (s.y > ground - LAND_REACH)
    landed = now_ground & ~grounded
    # 接地しているあいだは地面に載せ、地面の傾きぶんの上下の速さを持たせる。
    # のぼり坂ではこれが上向きになり、坂が終わったところでそのまま宙に浮く
    # 坂で得られる上向きの速さには上限をつける。ジャンプ台の終わりは崖になっているので、
    # そこを逆走などで乗り越えると地面の高さが 1 ステップで数 m 跳ね上がり、
    # 上限がないと車が空のかなたまで打ち上がってしまう。
    # 走っている速さより急に持ち上がることはない（傾き 45 度が上限）とみなす
    hspeed = np.sqrt(s.vx * s.vx + s.vz * s.vz)
    lim = hspeed + SLOPE_VY_MIN
    slope_vy = np.clip((ground - ground0) / DT, -lim, lim)
    s.y = np.where(now_ground, ground, s.y)
    s.vy = np.where(now_ground, slope_vy, s.vy)
    s.on_ground = now_ground.astype(np.float64)
    s.air = np.where(now_ground, 0.0, s.air + DT)

    # --- トリック（空中で回ってから着地するとブースト）------------------------
    tricks = np.where(landed, np.floor(np.abs(s.spin) / TRICK_TURN), 0.0)
    s.boost = s.boost + tricks * TRICK_BOOST
    s.spin = np.where(now_ground, 0.0, s.spin)

    # --- コースの端（ガードレール）---------------------------------------------
    # 接地しているときだけ当たる。大きく飛んでいるあいだは外へ出られる
    srx, srz = -np.cos(chead), np.sin(chead)
    lateral = (s.x - cx) * srx + (s.z - cz) * srz
    limit = cwidth / 2
    over = np.abs(lateral) - limit
    hit = now_ground & (over > 0)
    push = np.where(hit, np.sign(lateral) * over, 0.0)
    s.x = s.x - push * srx
    s.z = s.z - push * srz
    # 壁の外を向いている速度だけを消す。前へ進む速度はそのまま残し、
    # 擦っているあいだ「1 秒あたり」で減速させる。
    # ここを 1 フレームごとの掛け算にすると、壁に触れた車が 1 秒で止まってしまう
    vn = s.vx * srx + s.vz * srz
    into = hit & (np.sign(vn) == np.sign(lateral)) & (lateral != 0)
    s.vx = np.where(into, s.vx - vn * srx, s.vx)
    s.vz = np.where(into, s.vz - vn * srz, s.vz)
    scrape = np.where(hit, max(0.0, 1.0 - WALL_DRAG * DT), 1.0)
    s.vx = s.vx * scrape
    s.vz = s.vz * scrape

    # --- 進んだ距離と周回 -------------------------------------------------------
    # 点の番号だけで測ると 1m きざみになってしまうので、点と点のあいだのずれも足して数える
    delta = np.mod((idx + along) - (idx0 + along0) + n / 2, n) - n / 2
    s.prog = s.prog + delta * course.spacing
    # 周回は「今までに終えた数」より増えたときだけ数える。スタート線をまたいで
    # 前後に往復しても二重に数えない
    done = np.floor(s.prog / course.length)
    lapped = done > s.lap
    s.lap = np.maximum(s.lap, done)

    # --- 落ちたらコースへ戻す ---------------------------------------------------
    fell = s.y < course.y[idx] - FALL_LIMIT
    _respawn(s, fell, course)

    return {"landed": landed & ~fell, "tricks": tricks, "fell": fell, "lapped": lapped, "hit": hit}


# --- AI が見るもの ------------------------------------------------------------

LOOKAHEAD = (12.0, 25.0, 42.0, 62.0, 88.0, 120.0)  # 何 m 先の中心線を見るか
OBS_DIM = 8 + 3 * len(LOOKAHEAD) + 4  # 30


def observe(s: State, car: Car, course: CO.Course) -> np.ndarray:
    """車から見た観測（形 (N, OBS_DIM)）。どれもだいたい -1〜1 に収まるようにしてある。

    並び:
        0-3   前後の速さ / 横滑り / 上下の速さ / 接地しているか
        4-5   ブーストの残り / 中心線からの左右のずれ（道の端で ±1）
        6-7   コースの向きと車の向きのずれ（sin, cos）
        8-25  この先 6 か所の中心線（左右のずれ / 高さの差 / 道幅）
        26-29 この先 40m にある仕掛け（加速パネル・砂・ジャンプ台・途切れ）
    """
    idx = s.seg.astype(np.int64)
    fx, fz = np.sin(s.yaw), np.cos(s.yaw)
    rx, rz = -np.cos(s.yaw), np.sin(s.yaw)
    vlong = s.vx * fx + s.vz * fz
    vlat = s.vx * rx + s.vz * rz

    cx, cz = course.x[idx], course.z[idx]
    chead, cwidth = course.heading[idx], course.width[idx]
    srx, srz = -np.cos(chead), np.sin(chead)
    lateral = (s.x - cx) * srx + (s.z - cz) * srz
    err = (chead - s.yaw + math.pi) % (2 * math.pi) - math.pi

    cols = [
        vlong / car.vmax,
        vlat / car.vmax,
        np.clip(s.vy / 20.0, -2.0, 2.0),
        s.on_ground,
        s.boost / BOOST_TIME,
        np.clip(lateral / (cwidth / 2), -2.0, 2.0),
        np.sin(err),
        np.cos(err),
    ]
    for d in LOOKAHEAD:
        j = (idx + int(round(d / course.spacing))) % course.n
        dx, dz = course.x[j] - s.x, course.z[j] - s.z
        cols.append((dx * rx + dz * rz) / d)  # 左右のずれ（その距離に対する割合）
        cols.append(np.clip((course.y[j] - s.y) / 10.0, -2.0, 2.0))
        cols.append(course.width[j] / 20.0)
    ahead = (idx[:, None] + np.arange(0, 40, 4)[None, :]) % course.n
    k = course.kind[ahead]
    for want in (CO.KIND_BOOST, CO.KIND_DIRT, CO.KIND_RAMP, CO.KIND_GAP):
        cols.append((k == want).any(axis=1).astype(np.float64))
    return np.stack(cols, axis=1).astype(np.float32)


# --- 学習なしの運転者 ---------------------------------------------------------

HEUR_MARGIN = 0.85  # コーナーで、グリップの限界の何割まで攻めるか


def heuristic_action(s: State, car: Car, course: CO.Course,
                     skill: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """学習なしの運転者。先の中心線へ向かってステアを切り、コーナーの手前で減速する。

    skill を下げると、狙う速度が落ちて弱くなる（対戦相手の強さの調整に使う）。
    戻り値: (throttle, steer, jump)
    """
    idx = s.seg.astype(np.int64)
    fx, fz = np.sin(s.yaw), np.cos(s.yaw)
    rx, rz = -np.cos(s.yaw), np.sin(s.yaw)
    vlong = s.vx * fx + s.vz * fz

    # 速いほど遠くを見る
    look = np.clip(10.0 + vlong * 0.75, 12.0, 46.0)
    j = (idx + np.round(look / course.spacing).astype(np.int64)) % course.n
    dx, dz = course.x[j] - s.x, course.z[j] - s.z
    side = dx * rx + dz * rz
    front = np.maximum(dx * fx + dz * fz, 1.0)
    steer = np.clip(np.arctan2(side, front) * 2.2, -1.0, 1.0)

    # この先のコーナーのきつさから、出してよい速度を決める
    a = (idx + int(round(20 / course.spacing))) % course.n
    b = (idx + int(round(70 / course.spacing))) % course.n
    swing = np.abs((course.heading[b] - course.heading[a] + math.pi) % (2 * math.pi) - math.pi)
    radius = 50.0 / np.maximum(swing, 1e-3)
    # 曲がれる限界は step() と同じ式で見積もる（ここがずれるとコーナーで膨らむ）
    lat_accel = (LAT_BASE + LAT_PER_GRIP * car.grip) * HEUR_MARGIN
    top = car.vmax * np.where(s.boost > 0, BOOST_VMAX, 1.0)  # ブースト中はそのぶん速く走る
    want = np.minimum(np.sqrt(lat_accel * radius), top) * skill
    throttle = np.clip((want - vlong) * 0.35, -1.0, 1.0)

    # 空中では、着地に向けて車の向きをコースの向きへ戻す
    err = (course.heading[idx] - s.yaw + math.pi) % (2 * math.pi) - math.pi
    in_air = s.on_ground < 0.5
    steer = np.where(in_air, np.clip(-err * 2.0, -1.0, 1.0), steer)
    throttle = np.where(in_air, 1.0, throttle)

    # 道が途切れている手前では跳ぶ（ジャンプ台があるので普段は要らない）
    gap_soon = course.kind[(idx + int(round(6 / course.spacing))) % course.n] == CO.KIND_GAP
    jump = np.where(gap_soon & (s.on_ground > 0.5), 1.0, -1.0)
    return throttle, steer, jump


def action_to_controls(action: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """方策の出力（(N, 3)、-1〜1）を throttle / steer / jump にする。"""
    a = action.astype(np.float64)
    return a[:, 0], a[:, 1], a[:, 2]
