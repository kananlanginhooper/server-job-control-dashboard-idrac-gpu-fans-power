"""API tests. No broker, no hardware: MQTT messages are fed straight into the hub, and the agent's reply is faked."""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest
from app.core.config import get_settings
from app.main import create_app
from app.services import env_history
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    site = tmp_path / "site.json"
    site.write_text(json.dumps({"main": "server-a", "node": "server-b"}))
    monkeypatch.setenv("SJC_SITE_FILE", str(site))
    monkeypatch.setenv("FRAME_ANCESTORS", "http://wrapper.test:8097")
    monkeypatch.setenv("SJC_LEGACY_API", "")
    monkeypatch.setenv("SJC_CONTROL_NETS", "testclient,10.")  # TestClient calls from "testclient"
    get_settings.cache_clear()
    app = create_app(start_mqtt=False)
    with TestClient(app) as c:
        c.hub = app.state.hub
        yield c
    get_settings.cache_clear()


def publish(hub, host, part, value):
    hub.ingest(f"sjc/{host}/{part}", (value if isinstance(value, str) else json.dumps(value)).encode())


def test_config_has_the_standard_shape_and_site(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert body["apiBase"] == "api/" and body["frameParents"] == ["http://wrapper.test:8097"]
    assert body["login"] == {"enabled": False, "issuer": "", "clientId": ""}
    assert body["site"]["main"] == "server-a"
    assert r.headers["content-security-policy"] == "frame-ancestors 'self' http://wrapper.test:8097"


def test_servers_reflect_what_agents_publish(client):
    publish(client.hub, "server-a", "status", "online")
    publish(client.hub, "server-a", "power", {"w": 300, "peak_5s": 320})
    publish(client.hub, "server-a", "bogus", {"x": 1})  # not a known part: ignored
    r = client.get("/api/v1/servers").json()
    a = r["servers"]["server-a"]
    assert a["status"] == "online" and a["power"]["w"] == 300 and a["idrac"] is None
    assert set(a["age_s"]) == {"status", "power"}
    assert client.get("/api/v1/servers/server-a/power").json() == {"w": 300, "peak_5s": 320}
    assert client.get("/api/v1/servers/nope").status_code == 404
    assert client.get("/api/v1/servers/server-a/bogus").status_code == 404
    assert client.get("/healthz").json()["servers"] == ["server-a"]


def test_gpu_live_keeps_one_reading_per_5_s_and_answers_since(client):
    card = {"temp": 60, "util": 50, "mem_used": 4e9, "mem_total": 8e9, "power_w": 70, "power_limit_w": None, "mem_util": 20}
    for t in (1000, 1002, 1005, 1010):  # 1002 is too soon after 1000: dropped
        publish(client.hub, "laptop", "gpu", {"at": t, "cards": [card]})
    publish(client.hub, "laptop", "sensors", {"at": 1010, "temps": [], "fans": []})  # a 1.1 part
    r = client.get("/api/v1/gpu-live").json()["hosts"]["laptop"]
    assert [p["t"] for p in r] == [1000, 1005, 1010] and r[0]["draw"] == 70 and r[0]["cap"] is None
    assert [p["t"] for p in client.get("/api/v1/gpu-live?since=1005").json()["hosts"]["laptop"]] == [1010]
    assert client.get("/api/v1/servers").json()["servers"]["laptop"]["sensors"]["at"] == 1010


def test_env_live_points_use_the_hubs_rules(client):
    a = client.get("/api/config").json()["site"]["main"]
    publish(client.hub, a, "status", "online")
    publish(client.hub, a, "idrac", {"fans": [{"rpm": 4000}, {"rpm": 4400}], "temps": [{"name": "Inlet", "c": 99}, {"name": "Exhaust", "c": 41}],
                                     "psu": {"ps1": {"v": 118}, "ps2": {"v": None}}})
    publish(client.hub, a, "sensors", {"temps": [{"chip": "coretemp", "label": "Package id 0", "c": 60}, {"chip": "nic", "label": "MAC", "c": 77},
                                                 {"chip": "nvme", "label": "Composite", "c": 52}]})
    publish(client.hub, a, "power", {"w": 300, "peak_5s": 320})  # the main server's power report takes the sample
    p = client.get("/api/v1/env-history?range=600").json()["points"][-1]
    # hottest: Inlet and the NIC sensor don't count; peak_5s is the power; one PSU without a reading
    assert p[f"temp_{a}"] == 60 and p[f"power_{a}"] == 320 and p[f"fan_{a}"] == 4400
    assert p[f"volt_{a}_ps1"] == 118 and f"volt_{a}_ps2" not in p


def test_fan_command_validation_and_unknown_host(client):
    assert client.post("/api/v1/servers/server-a/fans", json={}).status_code == 422  # neither pct nor auto
    assert client.post("/api/v1/servers/server-a/fans", json={"pct": 150}).status_code == 422
    assert client.post("/api/v1/servers/ghost/fans", json={"auto": True}).status_code == 404  # no agent seen


def test_fan_command_round_trip_and_refusal(client, monkeypatch):
    publish(client.hub, "server-a", "status", "online")
    sent = []

    class FakeClient:  # stands in for paho: answers the command like an agent would
        def loop_stop(self):
            pass

        def publish(self, topic, payload, qos=0):
            body = json.loads(payload)
            sent.append((topic, body))
            ok = body.get("auto") is True
            reply = {
                "id": body["id"],
                "ok": ok,
                **({"mode": "dell-auto"} if ok else {"error": "fan-control is running"}),
            }
            client.hub.ingest(f"sjc/server-a/result/{body['id']}", json.dumps(reply).encode())

    client.hub._client = FakeClient()
    r = client.post("/api/v1/servers/server-a/fans", json={"auto": True})
    assert r.status_code == 200 and r.json()["mode"] == "dell-auto"
    assert sent[0][0] == "sjc/server-a/cmd/fans" and sent[0][1]["auto"] is True
    r = client.post("/api/v1/servers/server-a/fans", json={"pct": 40})
    assert r.status_code == 409 and "fan-control" in r.json()["detail"]


def test_controls_are_lan_only(client, monkeypatch):
    monkeypatch.setenv("SJC_CONTROL_NETS", "10.")
    get_settings.cache_clear()
    r = client.post("/api/v1/servers/server-a/fans", json={"auto": True})  # "testclient" is not in 10.
    assert r.status_code == 403


def test_data_is_home_lan_only_and_router_excluded(client, monkeypatch):
    monkeypatch.setenv("SJC_CONTROL_EXCLUDE", "testclient")  # the router's address is excluded the same way
    get_settings.cache_clear()
    assert client.get("/api/v1/servers").status_code == 403
    assert client.get("/api/config").status_code == 403
    assert client.post("/api/v1/servers/server-a/fans", json={"auto": True}).status_code == 403
    assert client.get("/healthz").status_code == 200  # health stays open for Docker and monitors


def test_legacy_forward_off_when_unset(client):
    assert client.get("/api/state").status_code == 404


def test_env_history_stored_minutes_then_live_points():
    now = time.time()
    t0 = int(now // 60) * 60 - 120  # three stored minutes, the last one still filling

    def recorder(req: httpx.Request) -> httpx.Response:
        if req.url.params["metric"] != "power_peak_w" or req.url.params["host"] != "a":
            return httpx.Response(404)
        return httpx.Response(200, json={"bucket_s": 60, "points": [[t0, 500], [t0 + 60, 510], [t0 + 120, 400]]})

    live = [{"t": t0 + 100, "power_a": 505}, {"t": t0 + 125, "power_a": 520}, {"t": t0 + 130, "power_a": 530}]
    h = {"main": "a", "node": "b", "box": "c", "laptop": "laptop"}

    async def go(range_s):
        async with httpx.AsyncClient(transport=httpx.MockTransport(recorder)) as c:
            return await env_history.history(c, "http://rec", h, range_s, live)

    # up to 2 h: the live points replace the stored minutes from where they start (t0+100)
    r = asyncio.run(go(3600))
    assert r["bucket_s"] == 60 and [p["power_a"] for p in r["points"]] == [500, 510, 505, 520, 530]
    # longer: stored buckets, and live points only from the newest (still filling) bucket on
    assert [p["power_a"] for p in asyncio.run(go(86400))["points"]] == [500, 510, 520, 530]
