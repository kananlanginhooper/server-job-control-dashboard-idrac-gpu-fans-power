from __future__ import annotations

import json

from ..core.config import Settings
from ..schemas.config import AppConfig, Login


def load_site(path: str) -> dict:
    """This installation's machine names and descriptions (private JSON); {} = the UI's generic names."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def app_config(s: Settings) -> AppConfig:
    return AppConfig(basePath=s.ui_base_path, publicUrl=s.public_url, frameParents=s.frame_ancestors.split(),
                     login=Login(enabled=s.login == "on", issuer=s.oidc_issuer, clientId=s.oidc_client_id),
                     site=load_site(s.site_file))
