from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from ..core.config import Settings, get_settings
from ..services.mqtt_hub import MqttHub


def hub(req: Request) -> MqttHub:
    return req.app.state.hub


def client_ip(req: Request) -> str:
    return (req.client.host if req.client else "").removeprefix("::ffff:")


def lan_only(req: Request, s: Settings = Depends(get_settings)) -> str:
    """Data and controls only for the home LAN (SJC_CONTROL_NETS minus SJC_CONTROL_EXCLUDE); returns the caller's address."""
    ip = client_ip(req)
    if not ip.startswith(s.control_prefixes) or ip in s.control_excluded:
        raise HTTPException(403, "home LAN only")
    return ip
