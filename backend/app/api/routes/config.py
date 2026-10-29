from __future__ import annotations

from fastapi import APIRouter, Depends

from ...core.config import Settings, get_settings
from ...schemas.config import AppConfig
from ...services.site import app_config

router = APIRouter(tags=["config"])


@router.get("/api/config", response_model=AppConfig)
def config(s: Settings = Depends(get_settings)) -> AppConfig:
    """Runtime config the UI loads before it starts."""
    return app_config(s)
