"""将棋の対局 API のテスト（AI はランダムに指すものを使う）。"""

import pytest
from rest_framework.test import APIClient


@pytest.fixture
def client():
    return APIClient()


def _start(client, color="black"):
    res = client.post("/api/shogi/games/", {"human_color": color, "agent": "random", "level": "normal"}, format="json")
    assert res.status_code == 201, res.content
    return res.json()


@pytest.mark.django_db
def test_play_and_ai_replies(client):
    g = _start(client)
    assert g["your_turn"] and "7g7f" in g["legal_moves"]
    g = client.post(f"/api/shogi/games/{g['id']}/move/", {"move": "7g7f"}, format="json").json()
    assert len(g["moves"]) == 2  # 人の手 + AI の手
    assert g["kif"][0] == "▲７六歩(77)"


@pytest.mark.django_db
def test_ai_moves_first_when_human_is_white(client):
    g = _start(client, "white")
    assert len(g["moves"]) == 1 and g["your_turn"]


@pytest.mark.django_db
def test_illegal_move_rejected(client):
    g = _start(client)
    res = client.post(f"/api/shogi/games/{g['id']}/move/", {"move": "1a1b"}, format="json")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "illegal_move"


@pytest.mark.django_db
def test_undo_and_resign(client):
    g = _start(client)
    client.post(f"/api/shogi/games/{g['id']}/move/", {"move": "7g7f"}, format="json")
    g = client.post(f"/api/shogi/games/{g['id']}/undo/").json()
    assert g["moves"] == []
    g = client.post(f"/api/shogi/games/{g['id']}/resign/").json()
    assert g["result"] == "ai_win" and g["reason"] == "投了"
    assert client.get("/api/shogi/games/summary/").json()[0]["human_losses"] == 1


@pytest.mark.django_db
def test_single_repetition_is_not_sennichite():
    """同じ局面が 2〜3 回現れても千日手にしない（4 回目で千日手）。"""
    import cshogi

    from apps.shogi import services
    from apps.shogi.models import ShogiGame

    cycle = ["2h3h", "8b7b", "3h2h", "7b8b"]
    game = ShogiGame.objects.create(human_color="black", agent="random", level="normal")
    board = cshogi.Board()
    for rep in range(3):
        for u in cycle:
            board.push_usi(u)
            game.moves = " ".join([*game.move_list, u])
            services._judge(game, board)
        if rep < 2:
            assert not game.result, f"{rep + 2} 回目で終局してしまった"
    assert game.result == ShogiGame.Result.DRAW and game.reason == "千日手"
