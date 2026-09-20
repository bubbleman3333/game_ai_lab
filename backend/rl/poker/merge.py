"""別々に学習したスタックの深さを 1 つの戦略ファイルにまとめる。

    cd backend
    .\\.venv\\Scripts\\python -m rl.poker.merge --out runs/poker/v1/checkpoints/best.npz \\
        runs/poker/v1-d0/checkpoints/best.npz runs/poker/v1-d1/checkpoints/best.npz

情報集合の鍵は先頭が深さの番号なので、深さが違う表は**鍵がぶつからない**。
そのため単にまとめるだけでよい。同じ深さが 2 つ以上あると後のファイルで上書きされる（警告を出す）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def merge(paths: list[Path], out: Path) -> dict:
    table: dict[str, list[float]] = {}
    depths: dict[str, str] = {}
    meta: dict = {"merged_from": []}
    for path in paths:
        with np.load(path, allow_pickle=False) as z:
            keys = [str(k) for k in z["keys"]]
            avg = z["average"]
            file_meta = json.loads(str(z["meta"][0])) if "meta" in z.files else {}
        overlap = 0
        for i, k in enumerate(keys):
            depth = k[0]
            if depth in depths and depths[depth] != str(path):
                overlap += 1
            depths[depth] = str(path)
            table[k] = [float(v) for v in avg[i]]
        if overlap:
            print(f"警告: {path} は既にある深さを {overlap:,} 個上書きしました")
        meta["merged_from"].append({"path": str(path), "meta": file_meta})
        print(f"{path}: 情報集合 {len(keys):,} 個")

    keys_sorted = sorted(table)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        keys=np.array(keys_sorted),
        average=np.array([table[k] for k in keys_sorted], dtype=np.float32),
        meta=np.array([json.dumps(meta, ensure_ascii=False)]),
    )
    print(f"まとめて {out} に書きました（情報集合 {len(keys_sorted):,} 個）")
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    merge(args.inputs, args.out)


if __name__ == "__main__":
    main()
