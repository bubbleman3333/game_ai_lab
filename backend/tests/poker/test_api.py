"""ポーカーの API（apps/poker）のテスト。

一番大事なのは「**AI の手札が漏れていないこと**」。不完全情報ゲームなので、ここが漏れると
ゲームとして成り立たない。
"""

from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from apps.poker.models import PokerHand, PokerTable


@pytest.fixture
def client():
    return APIClient()


def _new_table(client, stack=200, agent="heuristic"):
    res = client.post("/api/poker/tables/", {"agent": agent, "stack": stack}, format="json")
    assert res.status_code == 201, res.content
    return res.json()


@pytest.mark.django_db
def test_agents_にはルールベースが必ず入る(client):
    res = client.get("/api/poker/agents/")
    assert res.status_code == 200
    ids = [a["id"] for a in res.json()]
    assert "heuristic" in ids


@pytest.mark.django_db
def test_テーブルを作ると1局目が配られる(client):
    view = _new_table(client)
    assert view["hand_no"] == 1
    assert len(view["your_hole"]) == 2
    assert view["pot"] >= 3, "スモールブラインド 1 + ビッグブラインド 2 は必ず入っている"
    assert view["button"] == 0, "1 局目は人がボタン"
    assert view["table_stacks"] == [200, 200]
    assert PokerTable.objects.count() == 1


@pytest.mark.django_db
def test_AIの手札はショーダウンまで返さない(client):
    view = _new_table(client)
    assert view["ai_hole"] is None
    # 降りて終わらせる（降りたときは相手の手札を見せない）
    while not view["finished"]:
        actions = view["actions"]
        kind = "fold" if actions["can_fold"] else "check"
        res = client.post(f"/api/poker/tables/{view['table_id']}/action/", {"kind": kind},
                          format="json")
        assert res.status_code == 200, res.content
        view = res.json()
    assert view["ai_hole"] is None, "降りて終わった局で相手の手札を見せてはいけない"
    assert view["result"]["showdown"] is False


@pytest.mark.django_db
def test_ショーダウンまで行けばAIの手札が見える(client):
    view = _new_table(client)
    guard = 0
    while not view["finished"] and guard < 30:
        guard += 1
        actions = view["actions"]
        kind = "call" if actions["can_call"] else "check"
        res = client.post(f"/api/poker/tables/{view['table_id']}/action/", {"kind": kind},
                          format="json")
        view = res.json()
    if view["result"]["showdown"]:
        assert view["ai_hole"] is not None and len(view["ai_hole"]) == 2
        assert len(view["board"]) == 5
        assert view["result"]["human_hand"] and view["result"]["ai_hand"]


@pytest.mark.django_db
def test_手番でないときは打てない(client):
    view = _new_table(client)
    table = PokerTable.objects.get(id=view["table_id"])
    table.state = {**table.state, "to_act": 1}
    table.save()
    res = client.post(f"/api/poker/tables/{view['table_id']}/action/", {"kind": "check"},
                      format="json")
    assert res.status_code == 409


@pytest.mark.django_db
def test_範囲外のレイズは断る(client):
    view = _new_table(client)
    if not view["actions"]["can_raise"]:
        pytest.skip("この配り方ではレイズできない")
    too_much = view["actions"]["max_raise_to"] + 1
    res = client.post(f"/api/poker/tables/{view['table_id']}/action/",
                      {"kind": "raise", "to": too_much}, format="json")
    assert res.status_code == 400


@pytest.mark.django_db
def test_ノーリミットなので枠と関係ない額も賭けられる(client):
    """AI は倍率の枠しか知らないが、人は好きな額を賭けられる（一番近い枠に読み替えて AI に渡す）。"""
    view = _new_table(client)
    actions = view["actions"]
    if not actions["can_raise"]:
        pytest.skip("この配り方ではレイズできない")
    odd = actions["min_raise_to"] + 1
    if odd > actions["max_raise_to"]:
        pytest.skip("刻む余裕がない")
    res = client.post(f"/api/poker/tables/{view['table_id']}/action/",
                      {"kind": "raise", "to": odd}, format="json")
    assert res.status_code == 200, res.content
    body = res.json()
    assert body["committed"][0] >= odd or body["finished"]


@pytest.mark.django_db
def test_局が終わる前に次を配れない(client):
    view = _new_table(client)
    if view["finished"]:
        pytest.skip("すでに終わっている")
    res = client.post(f"/api/poker/tables/{view['table_id']}/next/", format="json")
    assert res.status_code == 409


@pytest.mark.django_db
def test_何局か続けて打てて記録が残る(client):
    view = _new_table(client, stack=400)
    for _ in range(4):
        guard = 0
        while not view["finished"] and guard < 30:
            guard += 1
            actions = view["actions"]
            kind = "fold" if actions["can_fold"] else "check"
            view = client.post(f"/api/poker/tables/{view['table_id']}/action/", {"kind": kind},
                               format="json").json()
        res = client.post(f"/api/poker/tables/{view['table_id']}/next/", format="json")
        assert res.status_code == 200, res.content
        view = res.json()
    assert view["hand_no"] == 5
    # 最後に配った局が AI の行動だけで終わることもあるので 4 局以上
    assert PokerHand.objects.count() >= 4
    table = PokerTable.objects.get(id=view["table_id"])
    assert sum(table.stacks) == 800, "チップの総数は変わらない"


@pytest.mark.django_db
def test_成績の一覧が返る(client):
    _new_table(client)
    res = client.get("/api/poker/stats/")
    assert res.status_code == 200
    body = res.json()
    assert "agents" in body and "recent" in body


@pytest.mark.django_db
def test_無いテーブルは404(client):
    assert client.get("/api/poker/tables/00000000-0000-0000-0000-000000000000/").status_code == 404
    assert client.get("/api/poker/tables/not-a-uuid/").status_code == 404


@pytest.mark.django_db
def test_AIが手を混ぜた確率は局が終わるまで見せない(client):
    """途中で見せると、AI の手札がどのくらい強いかが透けてしまう。"""
    view = _new_table(client)
    assert all("probs" not in line for line in view["log"]), "局の途中で確率を返してはいけない"
    guard = 0
    while not view["finished"] and guard < 30:
        guard += 1
        assert all("probs" not in line for line in view["log"])
        kind = "call" if view["actions"]["can_call"] else "check"
        view = client.post(f"/api/poker/tables/{view['table_id']}/action/", {"kind": kind},
                           format="json").json()
    assert view["finished"]
