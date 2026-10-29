from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Login(BaseModel):
    enabled: bool = False
    issuer: str = ""
    clientId: str = ""


class AppConfig(BaseModel):
    """GET /api/config: the group-standard runtime config, plus this installation's site block."""
    apiBase: str = "api/"
    basePath: str = "/"
    publicUrl: str = ""
    frameParents: list[str] = Field(default_factory=list)
    login: Login = Field(default_factory=Login)
    site: dict[str, Any] = Field(default_factory=dict, description="machine names, roles and notes (private site file); empty = generic names")
