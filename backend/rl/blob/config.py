"""学習の設定。python -m rl.blob.train --help で上書きできる項目が見られる。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields


@dataclass
class RewardConfig:
    """1 手ごとの報酬（死んだら death だけ）。

        alive + attack*送った + cancel*相殺した + chain*連鎖数² + all_clear*全消し
        （連鎖数が min_chain 未満のときは small_chain を足す = 早撃ちの罰）

    **連鎖を組ませるための肝は small_chain**。もともと送るおじゃまの数は連鎖数に対して
    ねずみ算式に増える（3 連鎖 14 個 → 6 連鎖 124 個 → 9 連鎖 398 個）ので、大連鎖の得は
    十分にある。それでも AI が小さく撃ってしまうのは、**組みかけを壊すことに損がない**から。
    1 連鎖は 40 点 = おじゃま 0 個なので、報酬の上では「ただ消えただけ」に見えてしまう。
    そこで min_chain 未満で撃ったら罰を与え、「今はまだ撃たない」を覚えさせる。

    既定値は「連鎖オンリー」のスタイル（attack も cancel も 0 = おじゃまの数を見ない）。
    対戦向けの値は下の REWARD_PRESETS["versus"] を参照。
    """

    alive: float = 0.05
    attack: float = 0.0  # 相手に送ったおじゃま 1 個あたり
    cancel: float = 0.0  # 相殺したおじゃま 1 個あたり（守りの価値）
    chain: float = 0.15  # 連鎖数の 2 乗にかける（5 連鎖 → 3.75、9 連鎖 → 12.2）
    min_chain: int = 5  # これ未満の連鎖で撃つと small_chain の罰
    small_chain: float = -1.0
    all_clear: float = 2.0
    death: float = -5.0


# --- AI の 2 つのスタイル ------------------------------------------------------------
# どちらも同じ仕組み（同じネット・同じ学習コード）で、**報酬の付け方だけが違う**。
# 学習すると別々の run になるので、対戦画面の AI 選択に両方が並ぶ。

REWARD_PRESETS: dict[str, RewardConfig] = {
    # 連鎖オンリーの AI（既定）。おじゃまの数はいっさい見ず、**連鎖の段数だけ**を追う。
    # 早撃ちに罰があるので、大連鎖が組み上がるまで我慢する。
    "chain": RewardConfig(),
    # 対戦に勝つための AI。「相手に送ったおじゃまの数」をまっすぐ最大化する。
    # 連鎖の段数そのものには報酬を出さないので、小さい連鎖を速く何度も撃つ形になりやすいが、
    # 勝ち負けで言えばこちらが強い（対戦の目的にいちばん近い報酬なので）。
    "versus": RewardConfig(
        alive=0.05, attack=0.12, cancel=0.0, chain=0.0, min_chain=0, small_chain=0.0,
        all_clear=2.0, death=-5.0,
    ),
}

# スタイルごとに変える学習の設定（コマンドラインで指定したものが優先される）。
# 連鎖オンリーはおじゃまを降らせない。降ってくると組みかけが崩れて、連鎖を組む練習にならないため。
STYLE_DEFAULTS: dict[str, dict] = {
    "chain": {"garbage_start": 0.0, "garbage_end": 0.0},
    "versus": {"garbage_start": 0.0, "garbage_end": 0.6},
}


@dataclass
class TrainConfig:
    run_name: str = "default"
    # 報酬のスタイル（REWARD_PRESETS のキー）。--reward-* で個別に上書きできる
    reward_preset: str = "chain"
    episodes: int = 20000
    max_pairs: int = 400  # 1 ゲームの上限（これで打ち切り。死亡扱いにはしない）
    gamma: float = 0.98  # 連鎖は 10 手以上かけて組むので、テトリスより先を見る
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
    eps_decay_episodes: int = 2000
    hidden: int = 256
    layers: int = 3
    # 学習中にランダムなおじゃまを送る量（1 手あたりの期待個数）。start から end へ徐々に増やす。
    garbage_start: float = 0.0
    garbage_end: float = 0.6
    garbage_ramp_episodes: int = 6000
    checkpoint_every: int = 250  # 何エピソードごとに保存するか
    eval_every: int = 250  # 何エピソードごとに評価するか（0 で評価しない）
    eval_games: int = 10
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
