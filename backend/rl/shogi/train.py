"""将棋のネットを、強い AI 同士の棋譜から教師あり学習する（dlshogi と同じ考え方）。

実行例:
    python -m rl.shogi.train --run-name v1                      # data/shogi/hcpe/*_train.hcpe を全部使う
    python -m rl.shogi.train --run-name v1 --resume --epochs 6  # 続きから
    python -m rl.shogi.train --run-name dbg --max-positions 200000 --epochs 1   # 動作確認

学習の考え方:
    方策: 「強い AI が実際に指した手」を正解として、次の一手を当てる（分類。クロスエントロピー）
    価値: 「その対局で最後に勝ったのはどちらか」を正解として、局面の勝率を当てる
    この 2 つを 1 つのネットで同時に学ぶ。対局ではこのネットを使ってモンテカルロ木探索（mcts.py）で先を読む。

出力（runs/shogi/<run_name>/）はほかのゲームと同じ形。評価はテスト用の局面での正解率。
"""

from __future__ import annotations

import argparse
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

from ..common import append_jsonl, now_iso, runs_dir, write_json
from .data import HcpeDataset, count_hcpe, load_hcpe
from .model import PolicyValueNet, load, save

RUNS_DIR = runs_dir("shogi")
DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "shogi" / "hcpe"


@dataclass
class TrainConfig:
    run_name: str = "default"
    epochs: int = 4
    batch_size: int = 1024
    lr: float = 0.1
    weight_decay: float = 1e-4
    blocks: int = 10
    channels: int = 128
    value_coef: float = 1.0
    max_positions: int = 0  # 0 なら全部。動作確認で減らすとき
    eval_every: int = 1000  # 何バッチごとにテスト局面で評価・保存するか（止まっても続きから再開できるように）
    eval_positions: int = 20000
    workers: int = 2  # データを作るプロセス数（1 つあたり 1GB 以上メモリを使うので増やしすぎない）
    seed: int = 0


def evaluate(model: PolicyValueNet, loader, device) -> dict:
    model.eval()
    n = correct = vcorrect = vdecided = 0
    ploss = vloss = 0.0
    with torch.no_grad(), torch.autocast(device.type, enabled=device.type == "cuda"):
        for f1, f2, label, value in loader:
            f1, f2, label, value = f1.to(device), f2.to(device), label.to(device), value.to(device)
            p, v = model(f1, f2)
            ploss += float(F.cross_entropy(p.float(), label, reduction="sum"))
            vloss += float(F.binary_cross_entropy_with_logits(v.float(), value, reduction="sum"))
            correct += int((p.argmax(1) == label).sum())
            decided = value != 0.5
            vcorrect += int(((v > 0) == (value > 0.5))[decided].sum())
            vdecided += int(decided.sum())
            n += len(label)
    model.train()
    # 勝敗の正解率は、引き分けでない局面だけで数える
    return {"policy_accuracy": correct / n, "value_accuracy": vcorrect / max(1, vdecided),
            "policy_loss": ploss / n, "value_loss": vloss / n, "positions": n}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    d = TrainConfig()
    for f in fields(TrainConfig):
        ap.add_argument("--" + f.name.replace("_", "-"), type=type(getattr(d, f.name)), default=getattr(d, f.name))
    ap.add_argument("--resume", action="store_true")
    args = vars(ap.parse_args())
    resume = args.pop("resume")
    cfg = TrainConfig(**args)

    torch.manual_seed(cfg.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    out = RUNS_DIR / cfg.run_name
    write_json(out / "config.json", asdict(cfg))

    # 学習データはファイルから必要な分だけ読む（丸ごと読むと、子プロセスごとにコピーされてメモリが足りなくなる）
    train_paths = sorted(DATA_DIR.glob("*_train.hcpe"))
    n_train = count_hcpe(train_paths)
    rng = np.random.default_rng(cfg.seed)
    indices = rng.choice(n_train, min(cfg.max_positions, n_train), replace=False) if cfg.max_positions else None
    train_set = HcpeDataset(paths=train_paths, indices=indices)
    test = load_hcpe(sorted(DATA_DIR.glob("*_test.hcpe")))
    test = test[rng.choice(len(test), min(cfg.eval_positions, len(test)), replace=False)]
    print(f"学習 {len(train_set):,} 局面 / テスト {len(test):,} 局面  device={device}")

    loader = torch.utils.data.DataLoader(train_set, batch_size=cfg.batch_size, shuffle=True,
                                         num_workers=cfg.workers, drop_last=True, persistent_workers=cfg.workers > 0)
    test_loader = torch.utils.data.DataLoader(HcpeDataset(test), batch_size=cfg.batch_size, num_workers=0)

    model = PolicyValueNet(cfg.blocks, cfg.channels).to(device)
    step = epoch0 = 0
    best = 0.0
    if resume and (out / "checkpoints" / "latest.pt").exists():
        m, meta = load(out / "checkpoints" / "latest.pt", device)
        model.load_state_dict(m.state_dict())
        step, epoch0, best = meta.get("step", 0), meta.get("epoch", 0), meta.get("best", 0.0)
        print(f"resume from epoch {epoch0} step {step}")
    model.train()
    opt = torch.optim.SGD(model.parameters(), lr=cfg.lr, momentum=0.9, weight_decay=cfg.weight_decay, nesterov=True)
    total = cfg.epochs * len(loader)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg.lr, total_steps=total, pct_start=0.05)
    for _ in range(min(step, total - 1)):
        sched.step()
    scaler = torch.amp.GradScaler(enabled=device.type == "cuda")
    started = time.time()

    def checkpoint(epoch: int) -> None:
        nonlocal best
        res = evaluate(model, test_loader, device)
        meta = {"episode": step, "step": step, "epoch": epoch, "best": best, "config": asdict(cfg), "saved_at": now_iso()}
        save(model, out / "checkpoints" / "latest.pt", meta)
        is_best = res["policy_accuracy"] > best
        if is_best:
            best = res["policy_accuracy"]
            meta["best"] = best
            save(model, out / "checkpoints" / "best.pt", meta)
        append_jsonl(out / "evals.jsonl", {"episode": step, "step": step, "checkpoint": f"step_{step}",
                                           "score": res["policy_accuracy"], "is_best": is_best,
                                           "results": {"test": res}, "at": now_iso()})
        write_json(out / "status.json", {"run_name": cfg.run_name, "state": "running", "episode": step,
                                         "episodes": total, "elapsed_sec": round(time.time() - started, 1),
                                         "updated_at": now_iso()})
        print(f"  [eval] step={step:,} 指し手の一致率 {res['policy_accuracy']:.1%} 勝敗の正解率 {res['value_accuracy']:.1%}")

    state = "running"
    try:
        per_epoch = len(loader)
        for epoch in range(epoch0, cfg.epochs):
            skip = step - epoch * per_epoch if epoch == epoch0 else 0  # 再開時、この周で終わっている分
            for k, (f1, f2, label, value) in enumerate(loader):
                if k < skip:
                    continue
                f1, f2 = f1.to(device, non_blocking=True), f2.to(device, non_blocking=True)
                label, value = label.to(device), value.to(device)
                with torch.autocast(device.type, enabled=device.type == "cuda"):
                    p, v = model(f1, f2)
                    policy_loss = F.cross_entropy(p.float(), label)
                    value_loss = F.binary_cross_entropy_with_logits(v.float(), value)
                    loss = policy_loss + cfg.value_coef * value_loss
                opt.zero_grad(set_to_none=True)
                scaler.scale(loss).backward()
                scaler.step(opt)
                scaler.update()
                sched.step()
                step += 1
                if step % 100 == 0:
                    rate = step * cfg.batch_size / max(1e-9, time.time() - started)
                    append_jsonl(out / "metrics.jsonl", {"episode": step, "step": step, "epoch": epoch,
                                                         "policy_loss": float(policy_loss.detach()), "value_loss": float(value_loss.detach()),
                                                         "lr": sched.get_last_lr()[0], "positions_per_sec": round(rate),
                                                         "at": now_iso()})
                if step % 500 == 0:
                    print(f"step {step:,}/{total:,}  policy {float(policy_loss.detach()):.3f}  value {float(value_loss.detach()):.3f}  "
                          f"({rate:,.0f} 局面/秒)", flush=True)
                if step % cfg.eval_every == 0:
                    checkpoint(epoch)
            checkpoint(epoch + 1)
        state = "finished"
    except KeyboardInterrupt:
        state = "stopped"
    except Exception as e:  # メモリ不足などで止まったら、状態ファイルに残して見落とさないようにする
        state = "error"
        write_json(out / "status.json", {"run_name": cfg.run_name, "state": state, "error": repr(e)[:500],
                                         "episode": step, "episodes": total, "updated_at": now_iso()})
        raise
    write_json(out / "status.json", {"run_name": cfg.run_name, "state": state, "episode": step, "episodes": total,
                                     "elapsed_sec": round(time.time() - started, 1), "updated_at": now_iso()})


if __name__ == "__main__":
    main()
