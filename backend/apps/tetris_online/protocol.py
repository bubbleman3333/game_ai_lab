"""オンライン対戦の WebSocket メッセージ定義。

接続先: ws://<host>/ws/<tetris または blob>/rooms/<code>/?name=<ニックネーム>
すべて JSON で、"type" で種類を見分ける。フロント側の同じ定義は
frontend/src/api/online/protocol.ts。変えるときは両方を直すこと。

クライアント → サーバー
    {"type": "ready", "ready": true}                 準備完了（両者 ready で開始）
    {"type": "state", "rows": [...], "stats": {...}}  自分の盤面（相手画面の表示用。5〜10 回/秒程度）
    {"type": "attack", "lines": 4}                    相手に送る段数（相殺後）
    {"type": "topout", "stats": {...}}                自分がゲームオーバーになった
    {"type": "ping"}

サーバー → クライアント
    {"type": "welcome", "slot": 0}                    自分の番号（0 or 1）
    {"type": "room", "room": {...}}                   部屋の状態（参加者・ready・勝利数）
    {"type": "start", "seed": 123, "round": 1, "countdown_ms": 3000}
    {"type": "opponent_state", "slot": 1, "rows": [...], "stats": {...}}
    {"type": "garbage", "from_slot": 1, "lines": 4}   受け取るおじゃま
    {"type": "end", "winner_slot": 0, "reason": "topout", "room": {...}}
    {"type": "error", "code": "...", "message": "..."}
    {"type": "pong"}

※ 盤面の計算は各ブラウザが行い、サーバーは中継と勝敗の記録だけをする（不正対策はしていない）。
"""

COUNTDOWN_MS = 3000
MAX_ATTACK_PER_MESSAGE = 30
MAX_NAME_LENGTH = 20

# クライアント → サーバー
C_READY = "ready"
C_STATE = "state"
C_ATTACK = "attack"
C_TOPOUT = "topout"
C_PING = "ping"

# サーバー → クライアント
S_WELCOME = "welcome"
S_ROOM = "room"
S_START = "start"
S_OPPONENT_STATE = "opponent_state"
S_GARBAGE = "garbage"
S_END = "end"
S_ERROR = "error"
S_PONG = "pong"

# WebSocket を閉じるときのコード
CLOSE_ROOM_NOT_FOUND = 4004
CLOSE_ROOM_FULL = 4009
