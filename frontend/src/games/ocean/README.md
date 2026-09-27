# オーシャン・スイム（海を泳ぐ 3D ゲーム）

`/ocean`。海をどこまでも泳ぎ、クラゲとサメをやり過ごして距離と得点を伸ばす。
学習する AI は無く、画面だけで完結する（サーバーに何も送らない。最高記録はブラウザに保存）。

## 中身

```
sim/            ルール（React にも three.js にも依存しない。vitest で試せる）
  game.ts       進行そのもの。OceanGame.update(dt, input) → 起きた出来事（GameEvent[]）
  zones.ts      区間（浅瀬 → 沖合 → 夜の海）。クラゲの量・サメの間隔など、ルールに効く数字
  rng.ts        種を決められる乱数（テストで同じ海を再現するため）
  ocean.test.ts テスト
game/input.ts   キーボード・スマホのボタン → sim の Input
scene/          three.js の描画（絵だけ。ルールには影響しない）
  OceanScene.ts 場面の組み立て・カメラ・霧・区間の色の切り替え。毎フレーム update(dt, game)
  water.ts      海面（波）と海底（砂の起伏・光の揺らぎ）のシェーダー。波の高さの式は JS 側にもある（waveHeight）
  world.ts      空の球・太陽・星・光
  underwater.ts 水中だけの演出（海面から差す光の筋・漂う粒）。深いほど光の筋は薄く、霧は暗く近くなる（OceanScene）
  swimmer.ts    泳ぐ人（クロールの動き）
  creatures.ts  クラゲ・サメ・真珠・魚の群れ
  decor.ts      海底の岩・サンゴ・海藻（浅瀬だけ）。40m ごとの区画で作っては片づける
  effects.ts    泡・水しぶき・火花
  themes.ts     区間ごとの色（空・水・霧・海底）
sounds.ts       音（Web Audio でその場で作る。土台は lib/sound.ts）
components/     OceanCanvas（毎フレームのループ）・OceanHud・OceanTouch（スマホのボタン）
pages/OceanPage.tsx  タイトルと結果
ocean.css       このゲームの見た目（styles.css には足していない）
```

依存の向き: `pages → components → scene / sounds → sim`（sim は何にも依存しない）。

## ルールの要点（sim/game.ts）

- 前へは勝手に進む（3.4m/s、ダッシュで 5.6m/s）。左右に動け、押しているあいだ潜れる。
- **息**: 潜っているあいだ減り（約 30 秒。深いほど少し早い）、海面で戻る。切れると 1.4 秒ごとに体力が 1 減る。
- **深さ**: 沖合・夜の海では水深 30m（`MAX_DEPTH`）まで潜れる。浅瀬は海底（`zones.ts` の `floorY`）の手前で止まる。
  真珠の 2 割は深いところにあり、水深 9m より深いものは 40 点（`DEEP_PEARL_SCORE`）。
- **クラゲ**: 触れると体力 -1、1 秒動きが鈍り、1.6 秒無敵。潜る・避けるでやり過ごす。
- **サメ**: 一定の間隔で 1 匹現れる（`zones.ts` の `sharkInterval`）。
  1. `stalk` 20m の距離で周りを回る（背びれが海面に出る）。HUD に方向が出る
  2. `charge` 「今の泳ぎ方を続けたらいる場所」を狙ってまっすぐ突っ込む。向きは少ししか直せない
     （`SHARK_TURN_RATE`）ので、**突っ込みが始まってから横へ動き続ければ外れる**（`dodge` +20 点）
  3. 目の前（3.6m 以内）まで来たときに蹴ると追い払える（`punch` +50 点）
  4. 噛まれると体力 -2。回数（`sharkPasses`）ぶん突っ込んだら去る
- **真珠**: 拾うと +10 点。得点 = 距離(m) + 真珠 + かわし + 追い払い。
- 体力 6（ハート 3 つ）。0 になったら終わり。死因（サメ・クラゲ・溺れ）を結果に出す。

## 向きの決まり

レースと同じで **x = 右左（右がマイナス）、y = 上（0 が海面）、z = 前**。泳ぐ向きは常に +z。
サメの `yaw` は前 = 0 で、向きのベクトルは `(sin yaw, 0, cos yaw)`、右向きは `(-cos yaw, 0, sin yaw)`。

## 調整したくなりそうなところ

- サメの避けやすさ: `sim/game.ts` の `SHARK_TURN_RATE`（小さいほど避けやすい）と `SHARK_BITE_RANGE`
- サメの頻度・しつこさ: `sim/zones.ts` の `sharkInterval` / `sharkPasses`
- クラゲの多さ: `sim/zones.ts` の `jellyGap` / `jellyCount`
- 息の長さ: `sim/game.ts` の `AIR_DRAIN`
- 色: `scene/themes.ts`。区間を足すときは `sim/zones.ts` と `scene/themes.ts` の両方に同じ id で足す
- 海底の深さ・クラゲのいる深さ: `sim/zones.ts` の `floorY` / `jellyDepth`（見た目の海底もここから）
- 泳ぐ人の体つき: `scene/swimmer.ts` の `profile`（胴体の回転体の太さ）と手足の `limb()` の太さ
- 波の形: `scene/water.ts` の `WAVES`（シェーダーと JS の両方に自動で効く）

## 確かめ方

```powershell
cd frontend; npx vitest run src/games/ocean   # ルールのテスト
cd frontend; npx tsc -b                        # 型チェック
```
