#!/usr/bin/env python3
"""Build the GitHub Pages demo's mock API from a live capture, keeping its shape and numbers but none of its names.

    python ui/demo/make_mock.py <capture-dir> <site.json> [--out ui/demo/api]

<capture-dir> holds state.json, series.json, iohist.json, temphist.json and guardhist.json, saved from a running back end
(curl /api/state etc.). <site.json> is the installation's private site file: its main/node/box names are mapped to
the demo's server-a/server-b/desk-1. Every other string is replaced with a generic label unless it's an enum-like value
(status, state, mode...) that is already generic. Run the public-repo guard on the output before committing it.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

DEMO = {"main": "server-a", "node": "server-b", "box": "desk-1", "Box": "Desk 1", "nodeGpu": "GPU (node)", "boxGpu": "GPU (desk)"}
# string fields whose values are generic vocabulary (kept after host renaming)
KEEP = {"status", "state", "level", "unit", "proto", "mode", "profile", "kind", "role", "via", "type", "phase", "group",
        "redundancy", "rc", "health", "speed", "duplex", "fstype", "fan_mode", "to_mode", "from_mode"}
WORDS = {"title": "Task", "owner": "worker", "job": "work item", "what": "task", "detail": "detail", "name": "item", "model": "Disk model",
         "serial": "SN", "text": "event", "sensor": "sensor", "notes": "note", "label": "item", "by": "operator", "why": "reason",
         "sample": "process", "cmd": "process", "batch": "batch", "script": "push.sh", "dest": "/data/dest", "src_root": "/data/src",
         "dest_root": "/data/dest", "id": "id", "dev": None, "host": None, "session": "session", "doc": "", "note": "", "owner_doc": ""}
DEV_RX = re.compile(r"(sd[a-z]+\d*|nvme\d+(n\d+)?(p\d+)?|eno\d+|enp\w+|wlo\d+)")
IP_RX = re.compile(r"\b(?:10|172|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b")
DROP = {"claude", "dismissed", "roadmap", "lapcheck", "slow", "r720_folders", "laptop", "lapjobs", "remaining"}


class Mapper:
    def __init__(self, site: dict):
        self.hosts = {site[k]: DEMO[k] for k in ("main", "node", "box") if site.get(k)}
        self.hosts.update({site[k]: DEMO[k] for k in ("Box",) if site.get(k)})
        self.gpus = {site[k]: DEMO[k] for k in ("nodeGpu", "boxGpu") if site.get(k)}
        alts = sorted(self.hosts, key=len, reverse=True)
        self.rx = re.compile(r"(?<![A-Za-z0-9])(" + "|".join(map(re.escape, alts)) + r")(?![0-9])") if alts else None
        self.counters: dict[str, dict[str, str]] = {}

    def host(self, s: str) -> str:
        for real, demo in self.gpus.items():
            s = s.replace(real, demo)
        return self.rx.sub(lambda m: self.hosts[m.group(1)], s) if self.rx else s

    def label(self, key: str, value: str) -> str:
        """Stable generic label per (key, original value): the same original maps to the same label everywhere."""
        seen = self.counters.setdefault(key, {})
        if value not in seen:
            base = WORDS.get(key) or IP_RX.sub("192.0.2.x", key).replace("_", " ")
            seen[value] = f"{base} {len(seen) + 1}" if base else ""
        return seen[value]

    def ip(self, s: str) -> str:
        """LAN addresses -> the documentation range 192.0.2.0/24, one stable address per original."""
        return IP_RX.sub(lambda m: "192.0.2." + self.label("ip", m.group(0)).split()[-1], s)

    def key(self, k: str) -> str:
        k = self.ip(k)
        if k.startswith("/"):
            return self.label("path", k).replace("path ", "/data/folder-")
        return self.host(k)

    def value(self, k: str | None, v):
        if isinstance(v, dict):
            return {self.key(kk): self.value(kk, vv) for kk, vv in v.items() if kk not in DROP}
        if isinstance(v, list):
            return [self.value(k, x) for x in v]
        if not isinstance(v, str):
            return v
        v = self.ip(v)
        if IP_RX.fullmatch(v) or v.startswith("192.0.2."):
            return v
        if k in KEEP or k is None or (k and DEV_RX.fullmatch(k)):   # a device's own status ("live", "dead") is generic
            return self.host(v)
        if k in ("host", "dev") or DEV_RX.fullmatch(v):
            return self.host(v)
        if re.fullmatch(r"[\d.:\-T Z+]+", v):   # dates and times
            return v
        return self.label(k, v)


def scrub_numbers(text: str) -> str:
    """Nudge any number the public-repo guard's private word lists would flag (e.g. a 4-digit value that is also a
    private term) by one in its last digit, until the text is clean. Uses the guard's own rules when installed."""
    try:
        import sys
        sys.path.insert(0, "C:/claude-personal/public-repo-guard")
        import guard
        rules = [rx for name, rx in guard.load_rules()]
    except Exception:
        return text
    for _ in range(50):
        hit = next(((m.start(), m.end()) for rx in rules for m in rx.finditer(text) if re.fullmatch(r"\d+", m.group(0))), None)
        if not hit:
            return text
        a, b = hit
        text = text[:b - 1] + str((int(text[b - 1]) + 1) % 10) + text[b:]
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("capture"); ap.add_argument("site"); ap.add_argument("--out", default=str(Path(__file__).parent / "api"))
    a = ap.parse_args()
    site = json.loads(Path(a.site).read_text(encoding="utf-8"))
    m, cap, out = Mapper(site), Path(a.capture), Path(a.out)
    (out / "v1").mkdir(parents=True, exist_ok=True)
    captured_at = json.loads((cap / "state.json").read_text(encoding="utf-8")).get("now", 0)
    for name in ("state", "series", "iohist", "temphist", "guardhist"):
        d = json.loads((cap / f"{name}.json").read_text(encoding="utf-8"))
        d = {k: v for k, v in d.items() if k not in DROP} if isinstance(d, dict) else d
        (out / f"{name}.json").write_text(scrub_numbers(json.dumps(m.value(None, d), separators=(",", ":"))), encoding="utf-8")
    roles = {DEMO["main"]: "main server · catalogue, dashboard", DEMO["node"]: "GPU server · {nics} · {via}", DEMO["box"]: "intake desktop"}
    (out / "config.json").write_text(json.dumps({"apiBase": "api/", "basePath": "./", "publicUrl": "", "frameParents": [],
                                            "login": {"enabled": False, "issuer": "", "clientId": ""},
                                            "site": dict(DEMO, owner="the owner", roles=roles, peers={}),
                                            "demo": {"capturedAt": captured_at}}), encoding="utf-8")
    (out / "v1" / "servers.json").write_text(json.dumps({"at": 0, "mqtt": False, "servers": {}}), encoding="utf-8")
    print("mock API written to", out)


if __name__ == "__main__":
    main()
