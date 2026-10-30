# hub: the control-plane API (:8090)

`app.py` is the server-job-control hub: the API that the power guard, fan control, the GPU switch, the per-server agents and the
task runners call (`/api/powertarget`, `/api/runprofile`, `/api/throttle`, `/api/gpu`, `/api/quickcool`, `/api/meeting`, ...),
plus the dashboard data (`/api/state`, `/api/series`, ...). `job-progress.py` is a runner task (every 60 s) that fills the
job progress rows. `index.html` is the dashboard page the hub serves at `/`.

**It runs as a system service on the hub server, not in Docker** (owner, 2026-10-29). Run mode, power target, the GPU
switch, Quick Cool, meeting mode, throttles and power caps are the core safety layer below the jobs: they stay here.
Only dashboard/reporting endpoints may move into the FastAPI back end later, one at a time, behind the same address.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `HUB_CONFIG` | `hub/local/hub.json` | private values: host names (also the API's data keys), addresses, paths; see `hub.example.json` |
| `HUB_STATE_DIR` | this folder | where the state files live (`runprofile.json`, `meeting.json`, `gpu.json`, ...). Set it to the existing folder so the state never moves. |
| `HUB_PORT` | `8090` | listen port |
| `HUB_READ_ONLY` | off | `1` = check copy: serves GETs only; no background loops, no writes, no hardware polling, every POST refused |

## Deploy

`git pull`, then a restart of its systemd unit (the unit's ExecStart points at this `app.py` and sets
`HUB_STATE_DIR`). A restart is a few seconds of API downtime; callers retry.

The page needs no restart: the hub reads `index.html` from `HUB_STATE_DIR` on every request. After `git pull`, render it
there with `python3 hub/tools/render_page.py "$HUB_STATE_DIR/index.html"` (it fills the `@@CFG:<key>@@` tokens from the
config and writes the file atomically). Edit `hub/index.html` here, never the rendered copy on the server.

## How the public copy was made

The live file had host names, addresses and paths written into it. They were moved into `hub/local/hub.json`
(gitignored) and identifiers containing host names were renamed. `tools/verify_same_program.py` proves the result is
the same program: it puts the config values back and compares the syntax trees of the original and the public file
(docstrings ignored), and it lists every intended difference (the settings above).

`index.html` had the same kind of values; each is an `@@CFG:<key>@@` token now. Rendering it with the private config
reproduced the live page byte for byte (2026-10-29).
