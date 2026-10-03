# 灯守（ひもり） ― 夜の森を灯せ ―（物語つきタイピングゲーム）

`/typing`。森に消えた妹ミオを探して、灯守の見習いが夜の森を進む。
森の奥から近づく「影」（言葉をなくした者）の言葉をローマ字で打つと、影はホタルに戻る。
全 5 章（各章の最後にボス）＋ 物語を終えると遊べる「終わらない夜」。
学習する AI は無く、ブラウザだけで完結する（サーバーに何も送らない。セーブはブラウザとファイル）。

## 中身

```
sim/              ルール（React にも three.js にも依存しない。vitest で試せる）
  romaji.ts       ローマ字入力の判定（shi/si/ci、tsu/tu、nn、kka/xtuka、kya/kixya など）
  chapters.ts     章: 物語の文・敵の言葉・難しさ・ボス。終わらない夜（ENDLESS）もここ
  game.ts         進行。TypingGame.update(dt) / key(ch) / release() → 出来事（GameEvent[]）
  save.ts         セーブ（スロット 3 つ・物語の位置・自己ベスト・ファイルの書き出しと読み込み）
  rng.ts          種を決められる乱数（テストで同じ順に影を出すため）
  typing.test.ts  テスト
scene/            three.js（WebGL）の描画（絵だけ。ルールには影響しない）
  ForestScene.ts  森の組み立て・カメラ・ランタンの光・影の見た目・言葉の札を出す位置（labelPosition）
  themes.ts       章ごとの色と景色（霧の濃さ・水面・鳥居・石灯籠・夜明けの空）
  textures.ts     影・狐火・月・光のにじみを canvas で描く（画像ファイルは使わない）
  particles.ts    光の粒（倒したときのホタル・漂うホタル）
sounds.ts         音（Web Audio でその場で作る。土台は lib/sound.ts）。森の環境音は ForestAmbience（必ず stop()）
components/
  ForestCanvas.tsx  canvas と言葉の札（HTML を毎フレーム直接動かす）・キー入力・毎フレームのループ
  TypingHud.tsx     油・得点・コンボ・ボスの残り
  StoryView.tsx     物語（文字送り。1 行ごとに保存）
pages/TypingPage.tsx  セーブスロット → 拠点 → 物語 → 戦い → 結果 → 物語 … の流れ
typing.css        このゲームの見た目（styles.css には足していない）
```

依存の向き: `pages → components → scene / sounds → sim`（sim は何にも依存しない）。

## ルールの要点（sim/game.ts）

- 影は奥（`SPAWN_Z` = 30m）に出て近づいてくる。目の前（`REACH_Z`）まで来たら油 -1（ボスは -2）。
- 目の前に来るまでの秒数 = `baseTime + perChar × ローマ字の長さ`（章ごと）× 難しさ（やさしい 1.4 / ふつう 1 / むずかしい 0.75）。
- **狙い**: 誰も狙っていないとき、打ったキーで始まる影のうち一番近いものを狙う。打ち終えるまで変わらない。
  `Backspace` で外せる（打ちかけた分は最初から）。同時に出る影は、なるべく頭文字がかぶらない言葉を選ぶ。
- **油**（`MAX_OIL` = 5）が 0 で終わり。**30 打ミス無し**（`HEAL_COMBO`）で 1 戻る。
- **得点**: 1 打 10 点 × 倍率（10 コンボごとに +0.25、最大 ×4）。倒すと「かなの数 × 40 + 距離 × 4」× 倍率。
- **ボス**: 「なくした言葉」を順に打って返す。1 つ返すごとに押し戻す。目の前まで来ても消えず、押し戻されて今の言葉が最初から。
  `summonEvery` 秒ごとに子分の影を呼ぶ章もある。ボスがほどけると子分も光に戻る。
- **章ごとの変化**: 第二章は霧（`reveal` m より近づくまで言葉が読めず、狙えない）、第三章は速い狐火（`fastChance`）、
  第四章は左右に大きく揺れる（`sway`）、終章は短い文。終章はボスを削るほど空が明けていく（themes.ts の `dawnTop`）。
- **ランク**: 1 分あたりの正しいキー数 × 正確さ² で S / A / B / C（`rankOf`）。

## セーブ（sim/save.ts）

- スロット 3 つ。localStorage の `game-ai-lab:typing:slot:<番号>` に JSON で入る。
- 物語の位置は「章（`chapter`）・部分（`part`: intro / play / outro）・行（`line`）」。**1 行読むごとに保存**する。
- 今の章をクリアすると outro（その後の話）へ進み、読み終えると次の章の intro へそのまま続く。
  クリア済みの章は何度でも遊び直せる（物語の位置は変わらない。自己ベストだけ更新）。
- 「ファイルに書き出す」で `himori-save-<番号>.json` を保存し、「読み込む」で別のブラウザに持っていける。
- **セーブの形を変えたら `SAVE_VERSION` を上げ、`migrate()` で古い形も読めるようにする**（遊んでいる人のセーブを消さないため）。

## 足したくなりそうなところ

- 章を足す: `sim/chapters.ts` の `CHAPTERS` に足し、`scene/themes.ts` に同じ id の色を足す。
  言葉の `kana` はひらがな・カタカナ・「ー、。！？」だけ（漢字を入れるとテストが落ちる）。
- 言葉を足す・物語の文を変える: `sim/chapters.ts` だけ直せばよい。
- 難しさ: `sim/chapters.ts` の `baseTime` / `perChar` / `waves`、全体は `sim/game.ts` の `DIFFICULTIES`。
- 見た目: 色は `scene/themes.ts`、影の形は `scene/textures.ts`、札と HUD は `typing.css`。

## デバッグ

戦いの画面では、コンソールから `window.__typing` で進行を見られる。
例: `__typing.enemies.map(e => e.word.text)`、`__typing.oil = 5`（油を戻す）。
