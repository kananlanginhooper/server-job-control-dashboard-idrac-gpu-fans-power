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
| `backend/` | FastAPI (`app/core/config.py`, `api/routes/`, `schemas/`, `services/`): `/api/v1/servers` from MQTT, control POSTs, `/api/config`, optional forward of other `/api/*` calls to an existing dashboard API. Tests: `pytest` in `backend/` |
| `ui/` | Angular 20 standalone dashboard (zoneless, signals). Machine names and descriptions come from `/api/config` at runtime |
| `mosquitto/` | Broker config (LAN only) |

The per-server agents (iDRAC, GPU, fan-controller state, system metrics) and their helpers live in
[server-job-control-services-idrac-gpu-fans-power](https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power)
(`services/sjc-agent`, `lib/sjc_hw`). Topics and payloads:
[contracts/mqtt-topics.md @ ae58de0](https://github.com/kananlanginhooper/server-job-control-services-idrac-gpu-fans-power/blob/ae58de0/contracts/mqtt-topics.md) (version 1).

## Safety model (enforced by the agents)

- A separate fan controller (one per server) owns the fans, the Emergency path and GPU power limits. While its state file is fresh, the agent **refuses** manual fan and GPU commands.
- When the agent does hold manual fan control, it hands the fans back to the BMC's automatic curve when the hold lease runs out, when the controller comes back, or as soon as any sensor reaches its Emergency temperature (from the shared component-limits file).
- Control POSTs are accepted only from LAN address prefixes (`SJC_CONTROL_NETS`).

## Run it

```bash
cp .env.example .env        # fill in; never commit .env
mkdir -p deploy/local       # optional: deploy/local/site.json names your machines (see deploy/site.example.json)
docker compose up -d --build
```

`COMPOSE_PROFILES=hub` runs the broker, backend and UI. Each server runs its own agent from the services repo. Every service restarts on its own.

UI development: `cd ui && npm ci && npx ng serve --proxy-config proxy.conf.json` (forwards `/api` to a backend on `localhost:8000`).

API types: after changing a back-end schema, run `python backend/openapi_export.py` and then `cd ui && npm run api-types`; the UI imports the named types from `src/app/core/api.ts`.

## Config

All settings are environment variables; see `.env.example` and `backend/app/settings.py`. The UI follows the group
standard: `GET /api/config` returns `{ apiBase, basePath, publicUrl, frameParents, login: { enabled, issuer, clientId }, site }`,
and every response sends `Content-Security-Policy: frame-ancestors 'self' $FRAME_ANCESTORS`.

## Demo (GitHub Pages)

`docs/` is a static build of the UI on generic mock data. It needs no back end: the mock API is plain files under
`docs/api/*.json`, timestamps are moved to "now" in the browser, and controls do nothing.

- Rebuild: `cd ui && npm run build:demo` (or `npx ng serve --configuration demo` to work on it)
- Refresh the mock from a running back end: save `/api/state`, `/api/series`, `/api/iohist`, `/api/temphist` and
  `/api/guardhist` to a folder, then run `python ui/demo/make_mock.py <folder> deploy/local/site.json`. It keeps the
  shape and numbers, maps your machine names to `server-a`/`server-b`/`desk-1` and replaces every other label.
  Run the public-repo guard on the result before committing it.
