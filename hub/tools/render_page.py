"""Render the hub's page: hub/index.html with every @@CFG:<key>@@ replaced by that key's value from the hub config
(hub.example.json, then the private local/hub.json or $HUB_CONFIG over it; see hubcfg.py).

usage: render_page.py [out.html]   (default: print to stdout)
Deploy on the server: git pull, then `python3 hub/tools/render_page.py $HUB_STATE_DIR/index.html`. The hub reads the page
from its state dir on every request, so no restart is needed.
An unknown key is an error, so a missing private value never reaches the page as a literal token.
"""
import os
import re
import sys

HUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HUB)
from hubcfg import CFG  # noqa: E402

TOKEN = re.compile(r"@@CFG:([A-Za-z0-9_]+)@@")


def render(text):
    missing = sorted({k for k in TOKEN.findall(text) if k not in CFG})
    if missing:
        sys.exit(f"render_page: no config value for {', '.join(missing)}")
    return TOKEN.sub(lambda m: str(CFG[m.group(1)]), text)


if __name__ == "__main__":
    with open(os.path.join(HUB, "index.html"), encoding="utf-8", newline="") as f:
        page = render(f.read())
    if len(sys.argv) > 1:
        tmp = sys.argv[1] + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(page)
        os.replace(tmp, sys.argv[1])  # atomic: the hub never serves a half-written page
    else:
        sys.stdout.buffer.write(page.encode("utf-8"))
