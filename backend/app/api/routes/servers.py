from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ...schemas.servers import (
    PARTS,
    CommandResult,
    FanCommand,
    GpuLimitCommand,
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
    """Every server and every part its agent publishes (iDRAC, power, GPU, safety, run level, system)."""
    return h.all()


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
