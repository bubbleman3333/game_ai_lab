"""学習の設定。python -m rl.tetris.train --help で上書きできる項目が見られる。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields


@dataclass
class RewardConfig:
    """1 手ごとの報酬 = alive + line*消した列 + attack*火力 （死んだら death だけ）。"""

    alive: float = 0.1
    line: float = 0.2
    attack: float = 1.0
    death: float = -5.0


@dataclass
class TrainConfig:
    run_name: str = "default"
    episodes: int = 20000
    max_pieces: int = 1500  # 1 ゲームの上限（これで打ち切り。死亡扱いにはしない）
    gamma: float = 0.97
    lr: float = 5e-4
    batch_size: int = 512
    buffer_size: int = 200_000
    learn_start: int = 5_000  # この数だけ経験がたまってから学習を始める
    learn_every: int = 2  # 経験がいくつ増えるごとに 1 回学習するか
    target_sync: int = 2_000  # 何回学習するごとにターゲットネットを更新するか
    workers: int = 6  # ゲームを遊ぶ並列プロセス数（0 なら 1 プロセスで全部やる。デバッグ向け）
    weight_sync: int = 200  # 並列時、何回学習するごとに actor へ重みを配るか
    eps_start: float = 1.0
    eps_end: float = 0.01
    eps_decay_episodes: int = 1500
    hidden: int = 256
    layers: int = 3
    # 学習中にランダムなおじゃまを送る量（1 手あたりの期待段数）。start から end へ徐々に増やす。
    garbage_start: float = 0.0
    garbage_end: float = 0.25
    garbage_ramp_episodes: int = 5000
    checkpoint_every: int = 250  # 何エピソードごとに保存するか
    eval_every: int = 250  # 何エピソードごとに評価するか（0 で評価しない）
    eval_games: int = 10
    # 評価での対戦（match.py）。ヒューリスティック AI と「今の best.pt」の 2 人が相手。
    versus_games: int = 6  # 相手ごとの対戦数（打つ順番を入れ替えるので偶数にする）
    versus_max_pieces: int = 300  # 1 局の打ち切り。どちらも生き残ったら引き分け
    promote_win_rate: float = 0.55  # 今の best.pt にこの勝率以上で勝ったら best.pt を差し替える
    seed: int = 0
    device: str = "auto"  # auto / cuda / cpu
    reward: RewardConfig = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.reward is None:
            self.reward = RewardConfig()
        elif isinstance(self.reward, dict):
            self.reward = RewardConfig(**self.reward)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "TrainConfig":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})
