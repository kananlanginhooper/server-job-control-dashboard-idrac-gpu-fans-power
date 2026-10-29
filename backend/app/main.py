"""sjc-backend: HTTP API over what every server's sjc-agent publishes to MQTT.

GET  /api/v1/servers                      every server, every part (idrac, power, gpu, safety, runlevel, system)
GET  /api/v1/servers/{host}[/{part}]      one server / one part
POST /api/v1/servers/{host}/fans          {"pct": 20-100} | {"auto": true}   (refused by the agent while fan-control runs)
POST /api/v1/servers/{host}/gpu-limit     {"w": watts, "index": 0}           (same)
GET  /healthz
Anything else under /api/ goes to SJC_LEGACY_API when it is set (the classic dashboard), so the UI's other cards work.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager

import httpx
import paho.mqtt.client as mqtt
from fastapi import FastAPI, HTTPException, Request, Response

from sjc_hw.config import settings as S

PARTS = ("status", "idrac", "power", "gpu", "safety", "runlevel", "system")
servers: dict[str, dict] = {}            # host -> part -> payload (+ "_at": part -> receive time)
waiters: dict[str, tuple[threading.Event, dict]] = {}
mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"sjc-backend-{uuid.uuid4().hex[:6]}")
mq_state = {"connected": False, "since": None}


def on_connect(c, _u, _f, rc, _p=None):
    mq_state.update(connected=True, since=time.time())
    c.subscribe(f"{S.prefix}/+/+", qos=0)
    c.subscribe(f"{S.prefix}/+/result/+", qos=1)


def on_disconnect(*_a):
    mq_state["connected"] = False


def on_message(_c, _u, msg):
    parts = msg.topic.split("/")
    if len(parts) == 4 and parts[2] == "result":
        w = waiters.get(parts[3])
        if w:
            w[1].update(json.loads(msg.payload or b"{}"))
            w[0].set()
        return
    if len(parts) != 3 or parts[2] not in PARTS:
        return
    host, part = parts[1], parts[2]
    raw = msg.payload.decode(errors="replace")
    try:
        val = raw if part == "status" else json.loads(raw)
    except ValueError:
        return
    s = servers.setdefault(host, {"_at": {}})
    s[part], s["_at"][part] = val, time.time()


@asynccontextmanager
async def lifespan(_app):
    mq.on_connect, mq.on_disconnect, mq.on_message = on_connect, on_disconnect, on_message
    mq.reconnect_delay_set(1, 30)
    mq.connect_async(S.mqtt_host, S.mqtt_port, keepalive=30)
    mq.loop_start()
    app.state.http = httpx.AsyncClient(timeout=30)
    yield
    await app.state.http.aclose()
    mq.loop_stop()


app = FastAPI(title="Server job control", lifespan=lifespan)


def view(host: str) -> dict:
    s = servers.get(host)
    if s is None:
        raise HTTPException(404, f"no data from {host}")
    now = time.time()
    return {"host": host, **{p: s.get(p) for p in PARTS}, "age_s": {p: round(now - t, 1) for p, t in s["_at"].items()}}


@app.get("/healthz")
def healthz():
    return {"ok": True, "mqtt": mq_state, "servers": sorted(servers)}


def _site() -> dict:
    """This installation's machine names and descriptions (SJC_SITE_FILE, private JSON); {} = the UI's generic names."""
    try:
        with open(os.environ.get("SJC_SITE_FILE", ""), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


@app.get("/api/config")
def config():
    """Group-standard runtime config for the UI (DEV-STANDARD section 5), plus the site block."""
    env = os.environ.get
    return {"apiBase": "api/", "basePath": env("UI_BASE_PATH", "/"), "publicUrl": env("PUBLIC_URL", ""),
            "frameParents": env("FRAME_ANCESTORS", "").split(),
            "login": {"enabled": env("LOGIN", "off") == "on", "issuer": env("OIDC_ISSUER", ""), "clientId": env("OIDC_CLIENT_ID", "")},
            "site": _site()}


@app.middleware("http")
async def frame_ancestors(req: Request, call_next):
    r = await call_next(req)
    r.headers["Content-Security-Policy"] = f"frame-ancestors 'self' {os.environ.get('FRAME_ANCESTORS', '')}".strip()
    return r


@app.get("/api/v1/servers")
def all_servers():
    return {"at": time.time(), "mqtt": mq_state["connected"], "servers": {h: view(h) for h in sorted(servers)}}


@app.get("/api/v1/servers/{host}")
def one_server(host: str):
    return view(host)


@app.get("/api/v1/servers/{host}/{part}")
def one_part(host: str, part: str):
    if part not in PARTS:
        raise HTTPException(404, f"unknown part {part}")
    return view(host)[part]


def lan_only(req: Request) -> None:
    ip = (req.client.host if req.client else "").removeprefix("::ffff:")
    if not ip.startswith(S.control_nets):
        raise HTTPException(403, "controls can only be used from the home LAN")


async def send_command(host: str, name: str, body: dict, req: Request) -> dict:
    lan_only(req)
    if host not in servers:
        raise HTTPException(404, f"no agent seen for {host}")
    cid = uuid.uuid4().hex
    ev, res = threading.Event(), {}
    waiters[cid] = (ev, res)
    try:
        mq.publish(f"{S.prefix}/{host}/cmd/{name}", json.dumps(body | {"id": cid, "by": req.client.host if req.client else None}), qos=1)
        ok = await asyncio.to_thread(ev.wait, 15)
    finally:
        waiters.pop(cid, None)
    if not ok:
        raise HTTPException(504, f"{host} agent didn't answer in 15 s")
    if not res.get("ok"):
        raise HTTPException(409, res.get("error") or "refused")
    return res


@app.post("/api/v1/servers/{host}/fans")
async def fans(host: str, req: Request):
    return await send_command(host, "fans", await req.json(), req)


@app.post("/api/v1/servers/{host}/gpu-limit")
async def gpu_limit(host: str, req: Request):
    return await send_command(host, "gpu_limit", await req.json(), req)


HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "content-encoding", "host"}


@app.api_route("/api/{path:path}", methods=["GET", "POST"])
async def legacy(path: str, req: Request):
    """Forward the classic dashboard API (the UI's /api/state etc.) until each part moves here."""
    if path.startswith("v1/") or not S.legacy_api:
        raise HTTPException(404, "not found")
    if req.method == "POST":
        lan_only(req)
    hdrs = {k: v for k, v in req.headers.items() if k.lower() not in HOP}
    try:
        r = await app.state.http.request(req.method, f"{S.legacy_api}/api/{path}", params=req.query_params,
                                         content=await req.body() if req.method == "POST" else None, headers=hdrs)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"legacy API unreachable: {e.__class__.__name__}")
    return Response(r.content, r.status_code, {k: v for k, v in r.headers.items() if k.lower() not in HOP})
