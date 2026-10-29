"""sjc-backend: HTTP API over what every server's agent publishes to MQTT.

GET  /api/config                          runtime config for the UI (group standard + site block)
GET  /api/v1/servers                      every server, every part (idrac, power, gpu, safety, runlevel, system)
GET  /api/v1/servers/{host}[/{part}]      one server / one part
POST /api/v1/servers/{host}/fans          {"pct": 20-100} | {"auto": true}   (refused by the agent while fan-control runs)
POST /api/v1/servers/{host}/gpu-limit     {"w": watts, "index": 0}           (same)
GET  /healthz
Anything else under /api/ goes to SJC_LEGACY_API when it is set (the classic dashboard), so the UI's other cards work.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request

from .api.routes import config, legacy, servers
from .core.config import get_settings
from .services.mqtt_hub import MqttHub


def create_app(start_mqtt: bool = True) -> FastAPI:
    s = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.http = httpx.AsyncClient(timeout=30)
        if start_mqtt:
            app.state.hub.start()
        yield
        app.state.hub.stop()
        await app.state.http.aclose()

    app = FastAPI(title="Server job control", version="1", lifespan=lifespan)
    app.state.hub = MqttHub(s)

    @app.middleware("http")
    async def frame_ancestors(req: Request, call_next):
        r = await call_next(req)
        r.headers["Content-Security-Policy"] = f"frame-ancestors 'self' {s.frame_ancestors}".strip()
        return r

    app.include_router(config.router)
    app.include_router(servers.router)
    app.include_router(legacy.router)  # last: its /api/{path} catches what the others don't
    return app


app = create_app()
