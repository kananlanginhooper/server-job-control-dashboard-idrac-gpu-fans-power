"""Backend settings, all from environment variables (compose passes them from .env).

The agents that publish to MQTT live in the services repo; their topics and JSON shapes are its contract:
https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power/blob/ae58de0/contracts/mqtt-topics.md (version 1)
  machine-readable: https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power/blob/ae58de0/contracts/mqtt-topics.json
"""
from __future__ import annotations

import os
from dataclasses import dataclass

env = os.environ.get


@dataclass(frozen=True)
class Settings:
    mqtt_host: str = env("SJC_MQTT_HOST", "localhost")
    mqtt_port: int = int(env("SJC_MQTT_PORT", "1883"))
    prefix: str = env("SJC_MQTT_PREFIX", "sjc")
    legacy_api: str = env("SJC_LEGACY_API", "").rstrip("/")      # optional: forward other /api/* calls here; empty = none
    control_nets: tuple[str, ...] = tuple(env("SJC_CONTROL_NETS", "127.,10.,172.,192.168.").split(","))   # POSTs only from these


settings = Settings()
