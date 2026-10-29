from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from ..core.config import Settings, get_settings
from ..services.mqtt_hub import MqttHub


def hub(req: Request) -> MqttHub:
    return req.app.state.hub


def client_ip(req: Request) -> str:
    return (req.client.host if req.client else "").removeprefix("::ffff:")


def lan_only(req: Request, s: Settings = Depends(get_settings)) -> str:
    """Controls are accepted only from the home LAN prefixes (SJC_CONTROL_NETS); returns the caller's address."""
    ip = client_ip(req)
    if not ip.startswith(s.control_prefixes):
        raise HTTPException(403, "controls can only be used from the home LAN")
    return ip
