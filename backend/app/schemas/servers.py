from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator

# The parts each agent publishes; their JSON shapes are the services repo's MQTT contract (version 1), passed through as-is.
PARTS = ("status", "idrac", "power", "gpu", "safety", "runlevel", "system")


class ServerView(BaseModel):
    host: str
    status: Optional[str] = Field(None, description='"online" / "offline" (the agent\'s last will)')
    idrac: Optional[dict[str, Any]] = None
    power: Optional[dict[str, Any]] = None
    gpu: Optional[dict[str, Any]] = None
    safety: Optional[dict[str, Any]] = None
    runlevel: Optional[dict[str, Any]] = None
    system: Optional[dict[str, Any]] = None
    age_s: dict[str, float] = Field(default_factory=dict, description="seconds since each part last arrived")


class ServersResponse(BaseModel):
    at: float
    mqtt: bool
    servers: dict[str, ServerView]


class MqttState(BaseModel):
    connected: bool = False
    since: Optional[float] = None


class Health(BaseModel):
    ok: bool
    mqtt: MqttState
    servers: list[str]


class FanCommand(BaseModel):
    """Either a manual fan speed for every fan, or back to the iDRAC's automatic curve."""
    pct: Optional[int] = Field(None, ge=1, le=100)
    auto: bool = False

    @model_validator(mode="after")
    def one_of(self):
        if not self.auto and self.pct is None:
            raise ValueError('send {"pct": 20-100} or {"auto": true}')
        return self


class GpuLimitCommand(BaseModel):
    w: int = Field(..., gt=0, description="GPU power limit in watts")
    index: int = Field(0, ge=0)


class CommandResult(BaseModel):
    """The agent's reply; extra fields (pct, until, mode, w, ...) depend on the command."""
    model_config = {"extra": "allow"}
    ok: bool
    id: Optional[str] = None
    cmd: Optional[str] = None
    at: Optional[float] = None
    error: Optional[str] = None
