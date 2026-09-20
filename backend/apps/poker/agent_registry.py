"""使える AI の一覧と、読み込み済みのキャッシュ（apps/blob_ai と同じ作り）。

AI の ID:
    "<run>:best" / "<run>:latest"   runs/poker/<run>/checkpoints/{best,latest}.{pt,npz}
    "heuristic"                     学習なしのルールベース（比較用。いつでも使える）

**中身は 2 種類ある**。

- `.pt` = **ニューラルネット（Deep CFR）**。局面をそのままベクトルにして入れるので、
  知らない場面が無く、スタックの深さも 1 つのネットでまかなう。**こちらが本命**。
- `.npz` = 表形式の CFR（最初に作った方）。手をバケツにまとめて表に持つ。
  深さごとに別の表なので、深いところが弱かった。比較のために残してある。

ルールベースは「AI」としてではなく**比較の基準**として置いてある。
"""

from __future__ import annotations

import threading
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from django.conf import settings

from apps.common.errors import NotFound
from rl.poker import players
from rl.poker.mccfr import Strategy
from rl.poker.model import PokerNet

HEURISTIC_ID = "heuristic"
_CHECKPOINT_KINDS = ("best", "latest")
NEURAL, TABLE, RULE = "neural", "table", "heuristic"


@dataclass(frozen=True)
class AgentInfo:
    id: str
    label: str
    run: str | None
    kind: str  # best / latest / heuristic
    family: str  # neural / table / heuristic
    path: Path | None
    updated_at: float | None
    detail: str = ""  # 画面に出す一言（学習量など）


def _runs_dir() -> Path:
    return Path(settings.TRAINING_RUNS_DIR) / "poker"


def _npz_rows(path: Path) -> int | None:
    """npz は zip なので、中の配列の「形」だけを読む（展開しない）。"""
    try:
        with zipfile.ZipFile(path) as z:
            with z.open("average.npy") as f:
                major, minor = np.lib.format.read_magic(f)
                if (major, minor) == (1, 0):
                    shape, _, _ = np.lib.format.read_array_header_1_0(f)
                else:
                    shape, _, _ = np.lib.format.read_array_header_2_0(f)
                return int(shape[0])
    except Exception:  # noqa: BLE001  壊れていても一覧は出したい
        return None


def _pt_traversals(path: Path) -> int | None:
    try:
        import torch

        blob = torch.load(path, map_location="cpu", weights_only=False)
        return int(blob.get("meta", {}).get("traversals", 0)) or None
    except Exception:  # noqa: BLE001
        return None


#: ファイルごとに (更新時刻, 説明)。更新されていたら読み直す
_details: dict[str, tuple[float, str]] = {}


def _detail(path: Path, family: str, mtime: float) -> str:
    hit = _details.get(str(path))
    if hit is not None and hit[0] == mtime:
        return hit[1]
    if family == NEURAL:
        n = _pt_traversals(path)
        text = f"学習した対局 {n:,}" if n else "ニューラルネット"
    else:
        n = _npz_rows(path)
        text = f"覚えた場面 {n:,}" if n else "表形式"
    _details[str(path)] = (mtime, text)
    return text


def list_agents() -> list[AgentInfo]:
    """ニューラルネットの best が先頭。最後にルールベース。"""
    found: list[AgentInfo] = []
    runs = _runs_dir()
    if runs.exists():
        for run_dir in sorted(runs.iterdir()):
            if not run_dir.is_dir():
                continue
            for kind in _CHECKPOINT_KINDS:
                for suffix, family in ((".pt", NEURAL), (".npz", TABLE)):
                    p = run_dir / "checkpoints" / f"{kind}{suffix}"
                    if not p.exists():
                        continue
                    mtime = p.stat().st_mtime
                    tag = "ニューラルネット" if family == NEURAL else "表形式"
                    found.append(AgentInfo(
                        id=f"{run_dir.name}:{kind}",
                        label=f"{run_dir.name}（{kind}・{tag}）",
                        run=run_dir.name, kind=kind, family=family, path=p, updated_at=mtime,
                        detail=_detail(p, family, mtime),
                    ))
    # ニューラルネット > 表形式、best > latest、新しい順
    found.sort(key=lambda a: (a.family != NEURAL, a.kind != "best", -(a.updated_at or 0)))
    found.append(AgentInfo(HEURISTIC_ID, "ルールベース（学習なし・比較用）", None, "heuristic",
                           RULE, None, None, "手札の強さで決める素朴な打ち方"))
    return found


def default_agent_id() -> str:
    return list_agents()[0].id


_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


def _loaded(info: AgentInfo):
    with _lock:
        cached = _cache.get(info.id)
        if cached and cached[0] == info.updated_at:
            return cached[1]
        if info.family == NEURAL:
            net, _ = PokerNet.load(info.path, "cpu")
            obj = net.to_numpy()
        else:
            obj = Strategy.from_file(info.path)
        _cache[info.id] = (info.updated_at or 0.0, obj)
        return obj


def get_policy(agent_id: str | None, seed: int = 0):
    """ID から「手を選ぶ関数」を返す。"""
    agent_id = agent_id or default_agent_id()
    if agent_id == HEURISTIC_ID:
        return players.heuristic(seed)
    info = next((a for a in list_agents() if a.id == agent_id), None)
    if info is None or info.path is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    obj = _loaded(info)
    if info.family == NEURAL:
        return players.neural_player(obj, seed=seed)
    # 表形式は「知らない場面」があるので、そこはルールベースで埋める
    return players.strategy_player(obj, seed=seed, fallback=players.heuristic(seed + 1))


def describe(agent_id: str) -> AgentInfo:
    info = next((a for a in list_agents() if a.id == agent_id), None)
    if info is None:
        raise NotFound(f"AI '{agent_id}' は見つかりません")
    return info
