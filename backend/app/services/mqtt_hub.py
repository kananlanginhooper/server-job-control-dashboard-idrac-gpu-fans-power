"""The latest of every part each agent publishes, plus the command/result round trip, over one MQTT connection."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid

import paho.mqtt.client as mqtt

from ..core.config import Settings
from ..schemas.servers import PARTS


class CommandError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class MqttHub:
    def __init__(self, settings: Settings):
        self.s = settings
        self.servers: dict[str, dict] = {}  # host -> part -> payload (+ "_at": part -> receive time)
        self.connected, self.since = False, None
        self._waiters: dict[str, tuple[threading.Event, dict]] = {}
        self._client: mqtt.Client | None = None

    # --- connection -------------------------------------------------------------------------------------------------
    def start(self) -> None:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"sjc-backend-{uuid.uuid4().hex[:6]}")
        c.on_connect, c.on_disconnect, c.on_message = self._on_connect, self._on_disconnect, self._on_message
        c.reconnect_delay_set(1, 30)
        c.connect_async(self.s.mqtt_host, self.s.mqtt_port, keepalive=30)
        c.loop_start()
        self._client = c

    def stop(self) -> None:
        if self._client:
            self._client.loop_stop()

    def _on_connect(self, c, _u, _f, _rc, _p=None):
        self.connected, self.since = True, time.time()
        c.subscribe(f"{self.s.mqtt_prefix}/+/+", qos=0)
        c.subscribe(f"{self.s.mqtt_prefix}/+/result/+", qos=1)

    def _on_disconnect(self, *_a):
        self.connected = False

    def _on_message(self, _c, _u, msg):
        self.ingest(msg.topic, msg.payload)

    def ingest(self, topic: str, payload: bytes) -> None:
        """One MQTT message: a part's latest value, or a command result someone is waiting for."""
        parts = topic.split("/")
        if len(parts) == 4 and parts[2] == "result":
            w = self._waiters.get(parts[3])
            if w:
                w[1].update(json.loads(payload or b"{}"))
                w[0].set()
            return
        if len(parts) != 3 or parts[2] not in PARTS:
            return
        host, part = parts[1], parts[2]
        raw = payload.decode(errors="replace")
        try:
            val = raw if part == "status" else json.loads(raw)
        except ValueError:
            return
        s = self.servers.setdefault(host, {"_at": {}})
        s[part], s["_at"][part] = val, time.time()

    # --- views --------------------------------------------------------------------------------------------------------
    def view(self, host: str) -> dict | None:
        s = self.servers.get(host)
        if s is None:
            return None
        now = time.time()
        return {
            "host": host,
            **{p: s.get(p) for p in PARTS},
            "age_s": {p: round(now - t, 1) for p, t in s["_at"].items()},
        }

    def all(self) -> dict:
        return {"at": time.time(), "mqtt": self.connected, "servers": {h: self.view(h) for h in sorted(self.servers)}}

    # --- commands -----------------------------------------------------------------------------------------------------
    async def command(self, host: str, name: str, body: dict, by: str | None, timeout: float = 15) -> dict:
        """Publish <prefix>/<host>/cmd/<name> and wait for <prefix>/<host>/result/<id>. Refusals raise CommandError(409)."""
        if host not in self.servers:
            raise CommandError(404, f"no agent seen for {host}")
        if not self._client:
            raise CommandError(503, "not connected to MQTT")
        cid = uuid.uuid4().hex
        ev, res = threading.Event(), {}
        self._waiters[cid] = (ev, res)
        try:
            self._client.publish(
                f"{self.s.mqtt_prefix}/{host}/cmd/{name}", json.dumps(body | {"id": cid, "by": by}), qos=1
            )
            ok = await asyncio.to_thread(ev.wait, timeout)
        finally:
            self._waiters.pop(cid, None)
        if not ok:
            raise CommandError(504, f"{host} agent didn't answer in {timeout:.0f} s")
        if not res.get("ok"):
            raise CommandError(409, res.get("error") or "refused")
        return res
