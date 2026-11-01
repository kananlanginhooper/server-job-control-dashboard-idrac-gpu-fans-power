from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ...core.config import Settings, get_settings
from ...services import env_history
from ...schemas.servers import (
    PARTS,
    CommandResult,
    FanCommand,
    GpuLimitCommand,
    GpuLive,
    Health,
    MqttState,
    ServersResponse,
    ServerView,
)
from ...services.mqtt_hub import CommandError, MqttHub
from ..deps import hub, lan_only

router = APIRouter(tags=["servers"])


@router.get("/healthz", response_model=Health)
def healthz(h: MqttHub = Depends(hub)) -> Health:
    return Health(ok=True, mqtt=MqttState(connected=h.connected, since=h.since), servers=sorted(h.servers))


@router.get("/api/v1/servers", response_model=ServersResponse, dependencies=[Depends(lan_only)])
def all_servers(h: MqttHub = Depends(hub)):
    """Every server and every part its agent publishes (iDRAC, power, GPU, safety, run level, system, sensors, disks,
    drive health)."""
    return h.all()


@router.get("/api/v1/gpu-live", response_model=GpuLive, dependencies=[Depends(lan_only)])
def gpu_live(since: float = 0, h: MqttHub = Depends(hub)):
    """Each host's GPU readings newer than `since` (Unix s), ~5 s apart, the last 2 h; the live GPU charts poll this."""
    return h.gpu_live(since)


@router.get("/api/v1/env-history", dependencies=[Depends(lan_only)])
async def env_hist(
    req: Request,
    range: int = Query(3600, ge=60, le=31 * 86400),
    since: float = 0,
    h: MqttHub = Depends(hub),
    s: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """The environment and total-power charts' points over `range` s: the metrics recorder's stored buckets, with the
    live MQTT points (~5 s, last 2 h) laid over them. {bucket_s, stored, points: [{t, power_<host>, ...}]}
    With `since`: only the live points newer than it (the page's 5-s top-up; no recorder call)."""
    live = list(h.env_live.pts)
    if since:
        return {"bucket_s": 5, "stored": 0, "points": [p for p in live if p["t"] > since]}
    if not s.recorder_url:
        return {"bucket_s": 5, "stored": 0, "points": [p for p in live if p["t"] >= live[-1]["t"] - range] if live else []}
    return await env_history.history(req.app.state.http, s.recorder_url.rstrip("/"), h.hosts, range, live)


@router.get("/api/v1/servers/{host}", response_model=ServerView, dependencies=[Depends(lan_only)])
def one_server(host: str, h: MqttHub = Depends(hub)):
    v = h.view(host)
    if v is None:
        raise HTTPException(404, f"no data from {host}")
    return v


@router.get("/api/v1/servers/{host}/{part}", response_model=Any | None, dependencies=[Depends(lan_only)])
def one_part(host: str, part: str, h: MqttHub = Depends(hub)):
    if part not in PARTS:
        raise HTTPException(404, f"unknown part {part}")
    v = h.view(host)
    if v is None:
        raise HTTPException(404, f"no data from {host}")
    return v[part]


async def _command(h: MqttHub, host: str, name: str, body: dict, by: str) -> dict:
    try:
        return await h.command(host, name, body, by)
    except CommandError as e:
        raise HTTPException(e.status, e.message) from e


@router.post("/api/v1/servers/{host}/fans", response_model=CommandResult)
async def fans(host: str, cmd: FanCommand, h: MqttHub = Depends(hub), by: str = Depends(lan_only)):
    """Manual fan % or back to the iDRAC's automatic curve. The agent refuses while fan-control runs (409)."""
    return await _command(h, host, "fans", {"auto": True} if cmd.auto else {"pct": cmd.pct}, by)


@router.post("/api/v1/servers/{host}/gpu-limit", response_model=CommandResult)
async def gpu_limit(host: str, cmd: GpuLimitCommand, h: MqttHub = Depends(hub), by: str = Depends(lan_only)):
    """GPU power limit in watts. The agent refuses while fan-control runs (409)."""
    return await _command(h, host, "gpu_limit", cmd.model_dump(), by)
