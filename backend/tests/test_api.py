"""API tests. No broker, no hardware: MQTT messages are fed straight into the hub, and the agent's reply is faked."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app


@pytest.fixture
def client(monkeypatch, tmp_path):
    site = tmp_path / "site.json"
    site.write_text(json.dumps({"main": "server-a", "node": "server-b"}))
    monkeypatch.setenv("SJC_SITE_FILE", str(site))
    monkeypatch.setenv("FRAME_ANCESTORS", "http://wrapper.test:8097")
    monkeypatch.setenv("SJC_LEGACY_API", "")
    monkeypatch.setenv("SJC_CONTROL_NETS", "testclient,10.")   # TestClient calls from "testclient"
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
    publish(client.hub, "server-a", "bogus", {"x": 1})          # not a known part: ignored
    r = client.get("/api/v1/servers").json()
    a = r["servers"]["server-a"]
    assert a["status"] == "online" and a["power"]["w"] == 300 and a["idrac"] is None
    assert set(a["age_s"]) == {"status", "power"}
    assert client.get("/api/v1/servers/server-a/power").json() == {"w": 300, "peak_5s": 320}
    assert client.get("/api/v1/servers/nope").status_code == 404
    assert client.get("/api/v1/servers/server-a/bogus").status_code == 404
    assert client.get("/healthz").json()["servers"] == ["server-a"]


def test_fan_command_validation_and_unknown_host(client):
    assert client.post("/api/v1/servers/server-a/fans", json={}).status_code == 422          # neither pct nor auto
    assert client.post("/api/v1/servers/server-a/fans", json={"pct": 150}).status_code == 422
    assert client.post("/api/v1/servers/ghost/fans", json={"auto": True}).status_code == 404  # no agent seen


def test_fan_command_round_trip_and_refusal(client, monkeypatch):
    publish(client.hub, "server-a", "status", "online")
    sent = []

    class FakeClient:   # stands in for paho: answers the command like an agent would
        def loop_stop(self):
            pass

        def publish(self, topic, payload, qos=0):
            body = json.loads(payload)
            sent.append((topic, body))
            ok = body.get("auto") is True
            reply = {"id": body["id"], "ok": ok, **({"mode": "dell-auto"} if ok else {"error": "fan-control is running"})}
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
    r = client.post("/api/v1/servers/server-a/fans", json={"auto": True})   # "testclient" is not in 10.
    assert r.status_code == 403


def test_legacy_forward_off_when_unset(client):
    assert client.get("/api/state").status_code == 404
