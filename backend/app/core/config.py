"""Settings: the only place the environment is read (compose passes .env through).

The agents that publish to MQTT live in the services repo; their topics and JSON shapes are its contract:
https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power/blob/ae58de0/contracts/mqtt-topics.md (version 1)
  machine-readable: https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power/blob/ae58de0/contracts/mqtt-topics.json
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # MQTT broker the agents publish to
    mqtt_host: str = Field("localhost", validation_alias="SJC_MQTT_HOST")
    mqtt_port: int = Field(1883, validation_alias="SJC_MQTT_PORT")
    mqtt_prefix: str = Field("sjc", validation_alias="SJC_MQTT_PREFIX")
    # optional: forward the UI's other /api/* calls to an existing dashboard API; empty = none
    legacy_api: str = Field("", validation_alias="SJC_LEGACY_API")
    # control POSTs only from these address prefixes (home LAN)
    control_nets: str = Field("127.,10.,172.,192.168.", validation_alias="SJC_CONTROL_NETS")
    # private site file: this installation's machine names and descriptions
    site_file: str = Field("", validation_alias="SJC_SITE_FILE")
    # group standard (DEV-STANDARD section 5)
    ui_base_path: str = Field("/", validation_alias="UI_BASE_PATH")
    public_url: str = Field("", validation_alias="PUBLIC_URL")
    frame_ancestors: str = Field("", validation_alias="FRAME_ANCESTORS")
    login: str = Field("off", validation_alias=AliasChoices("LOGIN"))
    oidc_issuer: str = Field("", validation_alias="OIDC_ISSUER")
    oidc_client_id: str = Field("", validation_alias="OIDC_CLIENT_ID")

    @property
    def control_prefixes(self) -> tuple[str, ...]:
        return tuple(p for p in self.control_nets.split(",") if p)

    @property
    def legacy_base(self) -> str:
        return self.legacy_api.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
