# 灯守（ひもり） ― 夜の森を灯せ ―（物語つきタイピングゲーム）

夜明けまでに、影にさらわれた妹ミオを連れ戻す。灯守の見習いが、ランタンひとつで夜の森を進む。
近づいてくる「影」（人に忘れられた言葉のなれの果て）の言葉をローマ字で打つと、影はホタルに還る。
全 5 章。章ごとに影に捕らわれた誰かをボスから助け出し、助けた者が仲間になって力をくれる。
物語を終えると「終わらない夜」（エンドレス）が遊べる。学習する AI は無く、ブラウザだけで完結する。

- Game AI Lab の中: `/typing`
- 単独のサイト: https://himori-typing.rakunowa.workers.dev （アクセス数は site_stats のダッシュボードの「灯守」）

## 中身

```
sim/              ルール（React にも three.js にも依存しない。vitest で試せる）
  romaji.ts       ローマ字入力の判定（shi/si/ci、tsu/tu、nn、kka/xtuka、kya/kixya など）
  chapters.ts     章: 物語の文（効果音・演出・背景の指定つき）・敵の言葉・難しさ・影の動き方の割合・ボス・仲間
  game.ts         進行。TypingGame.update(dt) / key(ch) / ringBell() / release() → 出来事（GameEvent[]）
  save.ts         セーブ（スロット 3 つ・物語の位置・自己ベスト・仲間の力・ファイルの書き出しと読み込み）
  rng.ts          種を決められる乱数（テストで同じ順に影を出すため）
  typing.test.ts  テスト
scene/            three.js（WebGL）の描画（絵だけ。ルールには影響しない）
  ForestScene.ts  森の組み立て・歩く動き・カメラ・ランタン・ブルーム・光の筋・鈴の光の輪・影の見た目
  shade.ts        影のシェーダー（15 種類 + ボス 5 種類の形）。SHAPES / NORMAL_SHAPES
  themes.ts       場面ごとの色と景色（章の森・村の夕暮れ/夜/朝・タイトル）。どの形の影が出るか
  mist.ts         地面を這う霧
  particles.ts    光の粒（倒したときのホタル・漂うホタル）
  textures.ts     狐火・月・光のにじみを canvas で描く（画像ファイルは使わない）
sounds.ts         効果音（打鍵・倒した・物語の効果音 storySfx）と森の環境音 ForestAmbience（必ず stop()）
music.ts          BGM（道中の曲とボス戦の曲。GameMusic。必ず stop()）
components/
  ForestCanvas.tsx  戦いの canvas・言葉の札・画面下の「今打っている言葉」・キー入力・BGM の切り替え
  ForestBackdrop.tsx メニューと物語の後ろの森（URL に #shades を付けると影の形を 15 種類並べて見せる）
  StoryView.tsx     物語（文字送り・効果音・揺れ/光/暗転・場面の見出し・あらすじ）
  TitleScreen.tsx   タイトル（「はじめる」を打つと始まる）
  TypingHud.tsx     油・得点・コンボ・ボスの残り・鈴
pages/TypingPage.tsx  タイトル → セーブ → 拠点 → 物語 → 戦い → 結果 → 物語 … の流れ
runtime.ts / standalone.tsx  単独のサイトとして動かすときの入口（../../../typing.html から読む）
typing.css        このゲームの見た目（styles.css には足していない）
```

依存の向き: `pages → components → scene / sounds / music → sim`（sim は何にも依存しない）。

## ルールの要点（sim/game.ts）

- 影は奥（`SPAWN_Z` = 30m）に出て近づいてくる。目の前（`REACH_Z`）まで来たら油 -1（ボスは -2）。
- 目の前に来るまでの秒数 = `baseTime + perChar × ローマ字の長さ`（章ごと）× 難しさ（やさしい 1.4 / ふつう 1 / むずかしい 0.75）。
- **影の動き方**（chapters.ts の `behaviors` が出る割合。章が進むほど種類が増える）:
  | 動き | 中身 | 見た目 |
  | --- | --- | --- |
  | walk | まっすぐ来る | 章ごとの候補 |
  | creep | 遠くではゆっくり、近づくほど速い | のっぽ・ろくろ首 |
  | hop | 跳ねては止まる | からかさ |
  | lunge | `LUNGE_Z` で止まって力を溜め（目と札が赤く脈打つ）、いきなり飛びかかる | 鬼影 |
  | blink | ときどき消えて、近くに現れる | 狐面・一つ目 |
  | zigzag | 大きく蛇行する | くらげ影・烏天狗 |
  | ambush | いきなり目の前の茂み（`AMBUSH_Z`）から出る。言葉は短い | 大蛇・猫影 |
  | tank | 言葉を 2 つ打たないと倒れない（札に × 2） | ぬりかべ |
  | split | 倒すと小さな影（mini）2 体に分かれる | 双子影 |
  見た目は scene/ForestScene.ts の `BEHAVIOR_SHAPES` で決めている（動きと形が結びつくように）。
- **狙い**: 誰も狙っていないとき、打ったキーで始まる影のうち一番近いものを狙う。打ち終えるまで変わらない（`Backspace` で外せる）。
- **油**（`MAX_OIL` = 5）が 0 で終わり。**30 打ミス無し**（`HEAL_COMBO`）で 1 戻る。
- **得点**: 1 打 10 点 × 倍率（10 コンボごとに +0.25、最大 ×4）。倒すと「かなの数 × 40 + 距離 × 4」× 倍率。
- **ボス**: 「なくした言葉」を順に打って返す。返すたびにボスが本音を漏らす（`reactions`）。目の前まで来ても消えず、押し戻されて今の言葉が最初から。
- **霧の章**: 遠いほど言葉がぼやける（`reveal` より遠いあいだは狙えないが、すぐ近づくので待たされない）。
- **仲間の力**（save.ts の `perksOf`）: クロ = 霧が薄く見える / ルリ = 油の上限 +1 / 忘れ神の鈴 = `Space` で 1 戦に 1 回、影を押し戻す / ミオ = 20 打で油が戻る。
- **ランク**: 1 分あたりの正しいキー数 × 正確さ² で S / A / B / C（`rankOf`）。

## 物語の書き方（sim/chapters.ts）

- 1 行は `{ who?, text, kind?, sfx?, fx?, bg? }`。
  - `kind`: `'scene'` 場面の見出し（「― その夜 ―」）/ `'recap'` あらすじ / `'voice'` 影や森の声（文字が震える）/ `'reward'` 仲間になった
  - `sfx`: 効果音（`higurashi` ひぐらし / `door` 障子 / `heartbeat` 心臓 / `gust` 風 / `footsteps` 足音 / `owl` フクロウ /
    `ignite` 火を灯す / `whisper` ささやき / `rumble` 地鳴り / `splash` 水音 / `bell` 鈴 / `flutter` 羽ばたき）
  - `fx`: `'shake'` 揺れる / `'flash'` 白く光る / `'dark'` 暗くなる
  - `bg`: その行から背景を切り替える（themes.ts の id。`village-dusk` / `village-night` / `village-lantern` / `village-morning` / 章の id）
- 章の最初の行は章の題名を大きく出す。章の 2 つ目以降は最初に `'recap'`（これまでのあらすじ）を置く。
- 戦いの最中の台詞: `waveLines`（波の始まり。波と同じ数）、`boss.appear`（ボス登場）、`boss.reactions`（言葉を返すたび。言葉と同じ数）。数がずれるとテストが落ちる。
- 物語を直したら、全文を通して読み直す（話の順番・誰がいつ名乗るか・時刻「あと何刻」が合っているか）。

## セーブ（sim/save.ts）

- スロット 3 つ。localStorage の `game-ai-lab:typing:slot:<番号>` に JSON で入る。物語は **1 行読むごとに保存**する。
- 「ファイルに書き出す」で `himori-save-<番号>.json`、「読み込む」で別のブラウザへ持っていける。
- **セーブの形を変えたら `SAVE_VERSION` を上げ、`migrate()` で古い形も読めるようにする**（遊んでいる人のセーブを消さないため）。

## 音

- 効果音・BGM ともに音声ファイルは使わず、Web Audio で合成している（lib/sound.ts の音量・ミュートが効く）。
- BGM（music.ts）: 道中は最初の波で始まり、影が近いほど激しくなる。ボスが出ると太鼓の連打と銅鑼のあとボスの曲
  （導入 4 小節 → 主旋律 8 小節 → 最高潮 4 小節）。全体をサチュレーションとコンプレッサーに通して音を太くしている。

## 公開（単独のサイト）

```powershell
cd frontend; npm run deploy:typing   # 書き出し（dist-typing/）→ Cloudflare Workers（typing.wrangler.jsonc）
```

- 入口は `frontend/typing.html`（題名・説明・共有したときの画像 `public-typing/og.jpg`・アクセス解析のタグ）。
- アクセス数: `site_stats` の `stats/src/sites.js` に `himori` として登録してある（ダッシュボードで見られる）。

## 足したくなりそうなところ

- 章を足す: `sim/chapters.ts` の `CHAPTERS` に足し、`scene/themes.ts` に同じ id の色を足す。
  言葉の `kana` はひらがな・カタカナ・「ー、。！？」だけ（漢字を入れるとテストが落ちる）。
- 影の形を足す: `scene/shade.ts` のシェーダーに形を足し、`SHAPES` と `EYE_COLORS` に登録する。`#shades` で見比べられる。
- 影の動きを足す: `sim/chapters.ts` の `Behavior` と `sim/game.ts` の `move()`、見た目は `BEHAVIOR_SHAPES`。
- 難しさ: `sim/chapters.ts` の `baseTime` / `perChar` / `waves`、全体は `sim/game.ts` の `DIFFICULTIES`。

## デバッグ

戦いの画面では、コンソールから `window.__typing` で進行を見られる。
例: `__typing.enemies.map(e => [e.word.text, e.behavior, e.z.toFixed(1)])`、`__typing.oil = 5`（油を戻す）。
