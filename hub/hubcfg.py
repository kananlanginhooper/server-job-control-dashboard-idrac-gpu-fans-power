"""This installation's private values (host names, addresses, paths) for the hub scripts.

hub.example.json (committed, generic) is read first, then the private file over it: $HUB_CONFIG, default local/hub.json
next to this file (gitignored). The host names are also the hub API's data keys (e.g. "<node>_w"), so they must match
what the callers expect.
"""
import json
import os

_DIR = os.path.dirname(os.path.abspath(__file__))


def _load():
    out = {}
    for p in (os.path.join(_DIR, "hub.example.json"), os.environ.get("HUB_CONFIG") or os.path.join(_DIR, "local", "hub.json")):
        try:
            with open(p) as f:
                out.update(json.load(f))
        except OSError:
            pass
    return out


CFG = _load()
MAIN, NODE, BOX, BOX_NAME = CFG["MAIN"], CFG["NODE"], CFG["BOX"], CFG["BOX_NAME"]
