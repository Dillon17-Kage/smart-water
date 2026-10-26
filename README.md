# Smart Water

IoT water distribution monitoring and leak detection. ESP32 nodes measure flow and
pressure on a closed-loop rig and publish over MQTT; an ASP.NET Core backend stores the
readings in PostgreSQL, detects leaks by per-zone mass balance (inlet − outlet), raises
alerts and controls the solenoid valves; a React web app shows it all live.

## What's in this repo

| Folder | Contents | Status |
|---|---|---|
| `db/` | PostgreSQL schema, seed for the current rig, scripts to add Zones B/C and node-1, tests | Done |
| `web/` | React + TypeScript + Tailwind web app, with a built-in rig simulator | Done (core pages) |
| `backend/` | ASP.NET Core (.NET 10). Serves the web app; API and services come in Phase 3 | Skeleton |
| `firmware/` | ESP32 sketch for Arduino IDE | Phase 1 |
| `tools/simulator/` | Fake MQTT node for testing the backend without the rig | Phase 3 |
| `docs/` | Notes, test records and calibration results for the report | — |
| `Dockerfile`, `render.yaml` | How Render builds and runs the system | Done |

## How it runs

| Part | Where | Cost |
|---|---|---|
| Database | Neon (PostgreSQL), Frankfurt | Free |
| MQTT broker | HiveMQ Cloud Serverless | Free |
| Backend + web app | One Render web service (free), built from the `Dockerfile` | Free |
| Fallback | Your laptop: `dotnet run` serves everything on http://localhost:5000 | Free |

The rig isn't running 24/7. The Render service sleeps when idle and wakes when the
dashboard is opened (about a minute). Before a test or presentation:

1. Open the dashboard and wait for the badge to show **Live**.
2. Power the ESP32 and switch on the pump.
3. Test or present. Afterwards switch off and close the dashboard.

Use a phone hotspot for the ESP32 at the venue; campus Wi-Fi login pages block it.

## Current rig (Zone A only)

| Item | Code | Node | GPIO |
|---|---|---|---|
| Zone A inlet flow (YF-S401) | F2 | node-2 | 25 |
| Zone A outlet flow (YF-S401) | F6 | node-2 | 26 |
| Zone A inlet pressure (100 PSI) | P2 | node-2 | 34 |
| Zone A solenoid | SV1 | node-2 | 23 |

Numbering follows the design document. Adding Zone B (F3, F7, P3, SV2 on node-2), Zone C
(node-3) and the trunk/return sensors (node-1) is a data change: run the matching script
in `db/rig/`. See `db/README.md`.

## Windows setup

| Install | For |
|---|---|
| Git (and optionally GitHub Desktop) | The repo |
| VS Code or Visual Studio 2022 Community | Backend and web |
| .NET 10 SDK | Backend |
| Node.js 22 LTS | Web app |
| Arduino IDE 2 + board package "esp32 by Espressif Systems" | Firmware |
| Arduino libraries: PubSubClient, ArduinoJson | Firmware |
| CP210x or CH340 USB driver (whichever your ESP32 board uses) | Uploading to the board |
| MQTT Explorer | Watching the messages the ESP32 sends |

You don't need Docker or a local PostgreSQL.

## Running it on your PC

```powershell
# 1. Web app with the simulator (no backend, no rig needed)
cd web
npm install
npm run dev                  # http://localhost:5173

# 2. Whole system the way Render runs it
cd web
npm run build
cd ..\backend\src\SmartWater.Api
dotnet user-secrets set "ConnectionStrings:Default" "<Neon connection string>"
dotnet run                   # http://localhost:5000, health check at /api/health
```

`/api/health` reports whether the database is reachable and how many zones and sensors
it found. That is the first thing to check after setting up Neon or deploying.

## Setting up the cloud services

**Neon** (database): create a project in the Frankfurt region, run `db/001_schema.sql`
then `db/002_seed.sql` in its SQL Editor, and create a `dev` branch for testing. Copy the
pooled connection string. Details in `db/README.md`.

**HiveMQ Cloud** (MQTT): create a free Serverless cluster and an access credential.
Needed from Phase 1. The host, username and password go in `firmware/node/secrets.h`
and in Render's environment settings, never in Git.

**Render** (backend + web app):

1. Push this repo to GitHub (private).
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml`.
3. When asked, paste the Neon connection string for `ConnectionStrings__Default`.
4. Deploy. Open `https://<your-service>.onrender.com/api/health` and check
   `"database": "ok"`. Every push to GitHub redeploys.

## Keeping secrets out of Git

Never commit: the Wi-Fi password, the HiveMQ login or the Neon connection string. They
live in `firmware/node/secrets.h` (ignored by Git), `dotnet user-secrets` on your PC,
and Render's environment settings. Keep the GitHub repo private.

## Build plan

| Phase | What | Status |
|---|---|---|
| 0 | Repo, database and web app on the design document's numbering, Render setup | Done |
| 1 | Node firmware: pulse counting, pressure, valve, Wi-Fi + MQTT, heartbeat, commands | Next |
| 2 | Rig tests: leak check, sensor-pair calibration, jug test | |
| 3 | Backend: ingestion, heartbeat monitor, detection, alerts, valve control, API, SignalR | |
| 4 | Connect the web app to the backend, end-to-end test | |
| 5 | Mock presentation: Zone B, demo script | |
| 6 | Final build: Zone C, node-1, all pressure sensors, remaining pages, testing, report | |
