# apps/tetris_online/ オンライン対戦（テトリス・ブロブチェイン共通）

ゲスト名で参加する 2 人対戦。部屋は REST で作り、対戦は WebSocket で行う。
ゲームは URL で分かれる: テトリス `/api/tetris/rooms/`・`/ws/tetris/rooms/<code>/`、ブロブチェイン `/api/blob/rooms/`・`/ws/blob/rooms/<code>/`
（`Room.game` に記録。違うゲームの部屋には入れない）。サーバーは中継と勝敗の記録だけなので、ゲームの中身は知らない。

| ファイル | 層 | 中身 |
|---|---|---|
| `protocol.py` | | **WebSocket のメッセージ定義（ここを見れば通信の全体がわかる）** |
| `consumers.py` | Controller | `RoomConsumer`（WebSocket）。受け取ったメッセージを service に渡して中継する |
| `views.py` | Controller | 部屋の作成・一覧・詳細（REST） |
| `serializers.py` | DTO | 部屋・参加者・結果の形 |
| `services.py` | Service | 入室・退室・準備完了・ゲームオーバー・勝敗の記録 |
| `selectors.py` | Repository | 部屋の読み取り、`room_state()` |
| `models.py` | Entity | `Room` / `RoomPlayer` / `MatchResult` |
| `routing.py` | | `/ws/tetris/rooms/<code>/`・`/ws/blob/rooms/<code>/` |

## 対戦の流れ
1. `POST /api/tetris/rooms/` で部屋を作る（5 文字のコード）
2. 2 人が `ws://…/ws/tetris/rooms/<code>/?name=…` に接続（3 人目は 4009 で切断）
3. 両者が `ready` → サーバーが同じ `seed` を配る（両者同じツモ順）→ 3 秒後に開始
4. 火力を出したら `attack` → 相手に `garbage` が届く。盤面は `state` で相手に見せる
5. ゲームオーバーで `topout` → 両者に `end`。勝敗は `MatchResult` に残る。もう一度 `ready` で次の試合
6. 対戦中に切断すると、残った側の勝ち

盤面の計算は各ブラウザで行い、サーバーは中継だけをする（不正対策はしていない）。
アカウント制にするときは `settings.REST_FRAMEWORK` の認証と、`RoomPlayer` にユーザーを足す。
