# Smart Water: web application

React 19 + TypeScript + Vite + Tailwind CSS. The browser front end for the Smart Water
leak detection system. In production the backend serves it (one Render service);
see the root README.

## Run it

You need Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:5173
```

It starts in **simulator mode**, so it works without the backend or the rig. The
simulator copies the rig as it is now (Zone A only: F2, F6, P2, SV1 on node-2). Set
`VITE_SIM_STAGE` in `.env` to `two-zone` or `full` to preview the later builds.
Sign in with any demo account (password `smartwater` for all):

| Username   | Role          | Can do                                           |
|------------|---------------|--------------------------------------------------|
| `admin`    | Administrator | Everything                                       |
| `operator` | Operator      | Monitor, acknowledge/resolve alerts, operate valves |
| `tech`     | Technician    | Monitor, acknowledge alerts, view valves         |
| `engineer` | Engineer      | Monitor and view alerts (read only)              |

Five wrong passwords lock an account for 15 minutes, as in the login activity diagram.

### Testing with the simulator

Click **Simulator** (bottom right) to:

- **Open a leak** in any built zone at 0.05 to 0.6 L/min. Within a second the zone balance
  rises and the leak shows as *suspected*; after 10 s above the 0.3 L/min threshold it is
  *confirmed*, an alert is raised and a banner appears on every page. Close the leak and it
  resolves after 10 s below the threshold.
- **Unplug a node.** After 30 s with no heartbeat it is reported offline, its sensors show
  "Node offline", and valve commands to it are refused.

Things worth trying: isolate a leaking zone from the Valves page or by clicking a valve on
the Network schematic. On the one-zone rig the bypass protects the pump, so the valve
interlock is off; in the `full` stage, closing the last open zone is refused.

## Pages

| Page      | What it shows |
|-----------|---------------|
| Dashboard | Supply, return and unaccounted water; per-zone inlet/outlet/pressure and balance against the leak threshold; live charts (5/10/15 min); every sensor's latest value and age |
| Network   | Schematic of tank → pump → zones → return with live values, zone status, animated flow, clickable valves |
| Alerts    | Active/resolved alerts with estimated zone, loss rate, water lost and start time; acknowledge and resolve; leak history |
| Valves    | Open/close each zone valve with confirmation; the command follows pending → sent → confirmed/timed out/rejected; command log |

Menu items and buttons follow the role (`src/auth/permissions.ts`). The backend must enforce
the same rules; hiding a button is not security.

## Switching to the real backend

Two ways, no page code changes:

- **Backend serves the app (normal use):** `npm run build` here, then `dotnet run` in
  `backend/src/SmartWater.Api` and open http://localhost:5000.
- **Live-reload while editing pages:** set `VITE_DATA_SOURCE=api` in `.env`, start the
  backend with `dotnet run`, then `npm run dev`. Vite forwards `/api` and `/hubs` to
  localhost:5000.

The ASP.NET Core API must provide:

| Method | Path                              | Body / returns |
|--------|-----------------------------------|----------------|
| POST   | `/api/auth/login`                 | `{ username, password }` → `{ user, token }`; on failure 401/423 with `{ message }` |
| GET    | `/api/rig`                        | `Rig`: zones, nodes, sensors, valves, current baselines, detection settings |
| GET    | `/api/readings/recent?seconds=N`  | `Reading[]` for all sensors, oldest first |
| GET    | `/api/alerts`                     | `Alert[]` newest first |
| GET    | `/api/leak-events`                | `LeakEvent[]` newest first |
| GET    | `/api/valve-commands`             | `ValveCommand[]` newest first |
| POST   | `/api/alerts/{id}/acknowledge`    | → `Alert` |
| POST   | `/api/alerts/{id}/resolve`        | → `Alert` (400 with `{ message }` if the leak is still active) |
| POST   | `/api/valves/{id}/commands`       | `{ action: "open" \| "close" }` → `ValveCommand` (a refused command comes back with `status: "rejected"` and a `rejectReason`, not as an error) |

SignalR hub at `/hubs/live` (JWT sent as `access_token`), server → client messages:
`Readings(Reading[])`, `NodeChanged`, `ValveChanged`, `ValveCommandChanged`,
`AlertChanged`, `LeakEventChanged`.

JSON is camelCase; every type is in `src/types.ts` and maps one-to-one to the PostgreSQL
tables (`flow_offset` → `flowOffset`). Because the backend serves this app from the same
address, no CORS setup is needed.

Sensor numbering follows the design document: F1 trunk, F5 return, F2–F4 zone inlets,
F6–F8 zone outlets, P1 trunk, P2–P4 zone inlets, P5 return. Pages find sensors by their
`position`, not their code, so they work at every stage of the build. Until node-1 (F1/F5)
is fitted, supply and return are shown as the sum of the zone inlets and outlets.

## Project layout

```
src/
  types.ts                 types mirroring the database tables
  data/source.ts           the DataSource interface every page uses
  data/mock/               in-browser simulator of the rig and backend
  data/api/apiSource.ts    real backend: fetch + SignalR
  state/                   signed-in user; live data store (1 Hz updates)
  auth/permissions.ts      what each role may do
  lib/rig.ts               zone balance (same arithmetic as v_zone_balance), zone status
  components/              layout, charts, valve control, UI pieces
  pages/                   Login, Dashboard, Network, Alerts, Valves
```

## Not built yet

Historical readings and reports, water usage, node/sensor detail, maintenance records and
user management. They plug into the same layout, permissions and data source.
