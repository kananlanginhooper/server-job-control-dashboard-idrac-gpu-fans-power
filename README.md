# Server job control dashboard: iDRAC, GPU, fans and power

A self-hosted dashboard and control API for a small rack of Dell PowerEdge servers and GPU boxes. It shows live
power, fans, temperatures, GPUs, run modes and long-running jobs, and drives fans and GPU power limits safely.

```
 every server                        main server
 ┌────────────┐   MQTT   ┌───────────┐   ┌──────────────┐   ┌───────────────┐
 │ sjc-agent  │ ───────▶ │ mosquitto │ ─▶│ backend      │ ◀─│ ui (Angular,  │
 │ ipmitool,  │ ◀─────── │           │   │ FastAPI      │   │ nginx)        │
 │ nvidia-smi │ commands └───────────┘   │ /api/v1, /api/config, optional legacy /api forward │
 └────────────┘                          └──────────────┘   └───────────────┘
```

| Folder | What |
|---|---|
| `agent/` | One per server. Publishes iDRAC sensors, DCMI power, GPUs, fan-controller state, run mode and system metrics to MQTT; runs fan and GPU commands it receives |
| `hw/` | Shared Python helpers (`sjc_hw`): ipmitool and nvidia-smi parsing, controller state readers, Emergency limits, psutil metrics |
| `backend/` | FastAPI: `/api/v1/servers` from MQTT, control POSTs, `/api/config`, optional forward of other `/api/*` calls to an existing dashboard API |
| `ui/` | Angular 20 standalone dashboard (zoneless, signals). Machine names and descriptions come from `/api/config` at runtime |
| `mosquitto/` | Broker config (LAN only) |

## Safety model

- A separate fan controller (one per server) owns the fans, the Emergency path and GPU power limits. While its state file is fresh, the agent **refuses** manual fan and GPU commands.
- When the agent does hold manual fan control, it hands the fans back to the BMC's automatic curve when the hold lease runs out, when the controller comes back, or as soon as any sensor reaches its Emergency temperature (from the shared component-limits file).
- Control POSTs are accepted only from LAN address prefixes (`SJC_CONTROL_NETS`).

## Run it

```bash
cp .env.example .env        # fill in; never commit .env
mkdir -p deploy/local       # optional: deploy/local/site.json names your machines (see deploy/site.example.json)
docker compose up -d --build
```

`COMPOSE_PROFILES=hub,agent` on the main server (broker + backend + UI + its agent), `agent` on the others.
Servers with an NVIDIA GPU add `compose.gpu.yaml` (needs nvidia-container-toolkit). Every service restarts on its own.

UI development: `cd ui && npm ci && npx ng serve --proxy-config proxy.conf.json` (forwards `/api` to a backend on `localhost:8000`).

## Config

All settings are environment variables; see `.env.example` and `hw/sjc_hw/config.py`. The UI follows the group
standard: `GET /api/config` returns `{ apiBase, basePath, publicUrl, frameParents, login: { enabled, issuer, clientId }, site }`,
and every response sends `Content-Security-Policy: frame-ancestors 'self' $FRAME_ANCESTORS`.
