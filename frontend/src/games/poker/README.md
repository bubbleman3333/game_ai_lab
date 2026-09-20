# frontend/src/games/poker/ ポーカーの画面

ヘッズアップ（1 対 1）ノーリミット・テキサスホールデムを AI と遊ぶ画面。

## ほかのゲームと作りが違うところ

ほかのゲームは `engine/` に TypeScript 版のルールを置き、**ブラウザ側でゲームを進める**。
ポーカーには `engine/` が無く、**進行はすべてサーバー（backend/apps/poker）**で行う。

相手の手札が見えないゲームだから。ブラウザに局面を渡すと、その中に AI の手札が入ってしまう
（DevTools を開けば見える）。そこで状態はサーバーに持ち、ブラウザは
「自分に見せていいもの」だけを受け取って表示する。`ai_hole` はショーダウンのときだけ入る。

このため Python 版と TypeScript 版を一致させる `fixtures` も無い（TS 版のルールが無いため）。

| ファイル | 中身 |
|---|---|
| `api/poker.ts` | API 呼び出しと型（backend/apps/poker と対） |
| `components/PlayingCard.tsx` | トランプ 1 枚（"As" の形で受け取る）。裏向きと空き枠も |
| `components/PokerFelt.tsx` | テーブルの見た目（AI 側・ボードとポット・自分側） |
| `components/ActionBar.tsx` | 人が打つところ。**額はスライダーで自由に決められる** |
| `pages/PokerPage.tsx` | 画面の本体（通信・音・AI の選択・テーブルの作り直し） |
| `pages/PokerStatsPage.tsx` | 強さページ（学習の推移と、人との対戦成績） |
| `sounds.ts` | 効果音（配る・チップ・降りる・勝ち負け・退場） |

## 覚えておくとよいこと

- **人は好きな額を賭けられる**（ノーリミット）。AI が知っているのは「ポットの 0.5 倍・1 倍・
  オールイン」だけなので、サーバー側で一番近いものに読み替えて AI に渡している。
  ワンタッチのボタン（`actions.presets`）はその倍率そのもの。
- テーブルの ID は `localStorage`（`poker.table`）に置いてあり、**再読み込みしても続きから**遊べる。
  無くなっていたら新しいテーブルを作る。
- スタックは局をまたいで持ち越すので**飛ぶ**ことがある（`result.busted`）。
  飛んだら「新しいテーブル」を押す。
- 濃い緑のテーブルの上では `--text-muted` や `--win` がそのままだと読みにくいので、
  `.poker-felt` の中だけ明るい色に上書きしている（`styles.css`）。
- AI の一覧（`agents`）には `family` が入っている（`neural` = ニューラルネット、
  `table` = 表形式、`heuristic` = 比較用のルールベース）。`detail` は「学習した対局 1,200,000」
  のような一言で、そのまま出せばよい。
- AI の中身の説明は `PokerPage.tsx` の一番下のカードにある。
  詳しくは [backend/rl/poker/README.md](../../../../backend/rl/poker/README.md)。
