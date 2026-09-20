# apps/poker/ ポーカーの API

ヘッズアップ（1 対 1）ノーリミット・テキサスホールデムを、人と AI で遊ぶための API。
ルールは [games/poker/](../../games/poker/)、学習は [rl/poker/](../../rl/poker/README.md)。

## ほかのゲームと作りが違うところ

**局の状態をサーバーに持つ**。ほかのゲーム（テトリス・オセロなど）は盤面が全部見えるので、
状態をブラウザに渡して「AI の手だけ聞く」作りにできる。ポーカーは**相手の手札が見えない**ので、
同じことをすると渡した瞬間に AI の手札が見えてしまう。
そのため `PokerTable` に状態を持ち、`serializers.table_view()` が
**その人に見せていいものだけ**を返す（AI の手札はショーダウンまで入れない）。

**人は好きな額を賭けられる**。AI は「ポットの倍率」で離散化した枠しか知らないが、
ノーリミットなので人が枠外の額を賭けられないと面白くない。そこで

- 本物の局面には**人が賭けたとおりの額**を当てる
- AI に渡す行動の履歴だけ `rules.translate()` で**一番近い枠**に読み替える

という分け方をしている（実物のポーカー AI でも使われている「アクション変換」）。

## 層

| ファイル | 層 | 中身 |
|---|---|---|
| `views.py` | Controller | AI の一覧、テーブル作成、局面、人の手、次の局、成績 |
| `serializers.py` | DTO | 入力のチェックと `table_view()`（**ここで AI の手札を落とす**） |
| `services.py` | Service | 局を配る・手を当てる・AI に打たせる・終局の後片付け |
| `selectors.py` | Repository | 直近の局、AI ごとの人間相手の成績 |
| `models.py` | Entity | `PokerTable`（今の局とスタック）・`PokerHand`（終わった局の記録） |
| `agent_registry.py` | | AI の ID ↔ `runs/poker/<run>/checkpoints/{best,latest}.npz`。読み込み済みをキャッシュ |

席は固定で**人が 0 番・AI が 1 番**。ボタン（スモールブラインド）は 1 局目が人で、以降交代する。

## API

```
GET  /api/poker/agents/                使える AI の一覧（先頭が既定）
POST /api/poker/tables/                {agent, stack} → テーブルを作って 1 局目を配る
GET  /api/poker/tables/<id>/           今の局面
POST /api/poker/tables/<id>/action/    {kind: fold|check|call|raise, to: 額}
POST /api/poker/tables/<id>/next/      次の局を配る
GET  /api/poker/stats/                 AI ごとの人間相手の成績と直近の局
```

AI の ID は `<学習名>:best` / `<学習名>:latest`（学習したもの）か `heuristic`（比較用のルールベース）。
中身は 2 種類あり、`agent_registry.py` が拡張子で見分ける。

- **`.pt` = ニューラルネット（Deep CFR）**。局面をそのままベクトルにして入れるので
  「知らない場面」が無く、スタックの深さも 1 つのネットでまかなう。**こちらが本命**。
- `.npz` = 表形式の CFR（最初に作った方）。手をバケツにまとめて表に持つので
  「まだ学習していない場面」があり、そこはルールベースで穴埋めする
  （`rl.poker.players.strategy_player` の `fallback`）。深いスタックが弱いので比較用。

ルールベースは AI 本体ではなく**比較の基準**。一覧ではニューラルネットの best が先頭に来る。

## 気をつけること

- スタックは持ち越すので**飛ぶ**（`result.busted`）。飛んだら新しいテーブルを作る。
  飛んだ出来事は `record_event()` で監視ページに出る。
- 返す `actions` は人の手番のときだけ中身が入る。`min_raise_to`〜`max_raise_to` の間なら
  どんな額でもレイズできる。`presets` は押しやすい額（AI が学習している倍率とオールイン）。
- ポーカーは運の幅が大きいので、`stats` の mbb/hand は**数百局では符号すら当てにならない**。
  AI の本当の強さは `rl/poker/evaluate.py` のミラー方式で測る。
