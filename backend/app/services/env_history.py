"""History for the environment and total-power charts: power, hottest sensor, fastest fan, PSU volts.

Stored points come from the metrics recorder (server-job-control-services, services/metrics-recorder: GET /series, one
point per minute for 24 h, hourly after that); the finer live points come from this app's own MQTT subscription, kept
for 2 h. Both are merged into the shape the UI draws, one dict per point, {"t", "<group>_<series>": value}, the keys the
classic hub's /api/series "env" block used, so the charts only change where they read from.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque

import httpx

# chart key ({main}/{node}/{box} = the site's host names), host role, recorder metric
SERIES = [
    ("power_{main}", "main", "power_peak_w"),
    ("power_{node}", "node", "power_peak_w"),
    ("power_{main}_peak", "main", "power_true_peak_w"),
    ("power_{node}_peak", "node", "power_true_peak_w"),
    ("power_{node}_gpu", "node", "gpu0_power_w"),
    ("power_{box}_gpu", "box", "gpu0_power_w"),
    ("power_laptop", "laptop", "power_w"),
    ("temp_{main}", "main", "hottest_c"),
    ("temp_{node}", "node", "hottest_c"),
    ("temp_{node}_gpu", "node", "gpu0_temp_c"),
    ("fan_{main}", "main", "bmc_fan_max_rpm"),
    ("fan_{node}", "node", "bmc_fan_max_rpm"),
    ("fan_{node}_gpu", "node", "gpu0_fan_rpm"),
    ("volt_{main}_ps1", "main", "psu_volt:ps1"),
    ("volt_{main}_ps2", "main", "psu_volt:ps2"),
    ("volt_{node}_ps1", "node", "psu_volt:ps1"),
    ("volt_{node}_ps2", "node", "psu_volt:ps2"),
]
LIVE_EVERY, LIVE_KEEP = 4.5, 1600  # ~5 s apart, 2 h


def hosts(site: dict) -> dict[str, str]:
    return {"main": site.get("main", "server-a"), "node": site.get("node", "server-b"), "box": site.get("box", "desk-1"),
            "laptop": "laptop"}


def _key(k: str, h: dict[str, str]) -> str:
    return k.format(**h)


def _max(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return max(vals) if vals else None


def metric(v: dict, name: str):
    """One recorder metric from a host's latest MQTT parts, by the recorder's own rules (docs/metrics-history.md)."""
    sy, pw, ip = v.get("system") or {}, v.get("power") or {}, v.get("idrac") or {}
    card = ((v.get("gpu") or {}).get("cards") or [{}])[0]
    if name == "power_peak_w":
        return pw.get("peak_5s", pw.get("w"))
    if name == "power_true_peak_w":
        return (sy.get("peak_power") or {}).get("peak_w")
    if name.startswith("gpu0_"):
        return card.get({"gpu0_power_w": "power_w", "gpu0_temp_c": "temp", "gpu0_fan_rpm": "fan_rpm"}[name])
    if name == "bmc_fan_max_rpm":
        return _max(f.get("rpm") for f in ip.get("fans") or [])
    if name.startswith("psu_volt:"):
        return ((ip.get("psu") or {}).get(name.split(":", 1)[1]) or {}).get("v")
    if name == "hottest_c":  # the hub's host_temp_max: BMC temps but Inlet, CPU packages, NVMe, SMART drives
        ts = (v.get("sensors") or {}).get("temps") or []
        return _max([t.get("c") for t in ip.get("temps") or [] if t.get("name") != "Inlet"]
                    + [t.get("c") for t in ts if t.get("chip") == "coretemp" and str(t.get("label", "")).startswith("Package")]
                    + [t.get("c") for t in ts if t.get("chip") == "nvme" and t.get("label") == "Composite"]
                    + [d.get("temp") for d in (v.get("health") or {}).get("drives") or []])
    if name == "power_w" and v.get("host") == "laptop":  # battery draw when unplugged, else CPU package + GPU
        p = sy.get("power") or {}
        if p.get("w") is not None:
            return p["w"]
        parts = [x for x in (p.get("cpu_pkg_w"), card.get("power_w")) if x is not None]
        return sum(parts) if parts else None
    return None


class EnvLive:
    """The last 2 h of chart points from MQTT, one every ~5 s, taken when the main server's power report arrives."""

    def __init__(self):
        self.pts: deque = deque(maxlen=LIVE_KEEP)

    def sample(self, servers: dict[str, dict], h: dict[str, str], t: float) -> None:
        if self.pts and t - self.pts[-1]["t"] < LIVE_EVERY:
            return
        p = {"t": t}
        for key, role, name in SERIES:
            v = servers.get(h[role])
            if v and v.get("status") == "online":
                val = metric(dict(v, host=h[role]), name)
                if val is not None:
                    p[_key(key, h)] = val
        self.pts.append(p)


async def history(client: httpx.AsyncClient, base: str, h: dict[str, str], range_s: int, live: list[dict]) -> dict:
    """The recorder's points for every chart series over range_s, then the live points newer than its last bucket."""

    async def one(key: str, role: str, name: str):
        try:
            r = await client.get(f"{base}/series", params={"host": h[role], "metric": name, "range": range_s}, timeout=10)
            return key, (r.json() if r.status_code == 200 else None)
        except (httpx.HTTPError, ValueError):
            return key, None

    got = await asyncio.gather(*(one(_key(k, h), role, name) for k, role, name in SERIES))
    bucket = next((d["bucket_s"] for _, d in got if d and d.get("bucket_s")), 60)
    rows: dict[float, dict] = {}
    for key, d in got:
        for t, val in (d or {}).get("points") or []:
            if val is not None:
                rows.setdefault(t, {"t": t})[key] = val
    pts = [rows[t] for t in sorted(rows)]
    # live points replace stored ones from where they start: over the whole 2 h they keep for short ranges, otherwise
    # only from the newest stored bucket on (it's still filling, and 5-s points inside hourly ones would be noise)
    start = live[0]["t"] if live and range_s <= 7200 else (pts[-1]["t"] if pts else 0)
    cut = max(start, time.time() - range_s)
    live = [p for p in live if p["t"] >= cut]
    if live:
        pts = [p for p in pts if p["t"] < cut]
    return {"bucket_s": bucket, "stored": len(pts), "points": pts + live}
