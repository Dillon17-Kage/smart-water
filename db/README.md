# Smart Water database (PostgreSQL 16+, hosted on Neon)

| File | What it does |
|---|---|
| `001_schema.sql` | All tables, constraints, indexes and two views |
| `002_seed.sql` | Roles, zones, settings and the hardware **as built now**: Zone A on node-2 (F2 GPIO18, F3 GPIO19, P1 GPIO32, SV1 GPIO26) |
| `rig/05_p1_zero.sql` | Sets P1's measured zero (0.38 V, provisional until measured on the final 5 V supply). Run it on any new database |
| `rig/10_zone_b.sql` | Adds node-3 with Zone B (F4, F5, P2, SV2) |
| `rig/20_zone_c.sql` | Adds node-4 (ESP32-C3) with Zone C (F6 GPIO5, F7 GPIO6, P3 GPIO3, SV3 GPIO7). Only once the board exists |
| `rig/30_trunk_return.sql` | Adds F1 and F8 to node-2. No trunk/return pressure sensors |
| `tools/flow_sensors_unwired.sql` | Optional: switches off F4-F7, so noise on unwired pins can't look like a leak. Not applied: the rig keeps every sensor on |
| `tools/reset_demo_data.sql` | Clears readings, leaks, alerts and commands before a presentation |
| `tests/test_current_rig.sql` | Simulated 0.4 L/min leak in Zone A on the current rig; rolls back |
| `tests/test_full_rig.sql` | Simulated 0.8 L/min leak in Zone B on the full rig, plus constraint checks; rolls back |

Sensors are numbered in order along the water path (this replaces the design document's
numbering):

| Where | Flow in | Flow out | Pressure | Valve |
|---|---|---|---|---|
| Trunk (main line, node-2) | F1 | | | |
| Zone A | F2 | F3 | P1 | SV1 |
| Zone B | F4 | F5 | P2 | SV2 |
| Zone C | F6 | F7 | P3 | SV3 |
| Return (node-2) | | F8 | | |

There are no trunk or return pressure sensors; the schema still allows them.
Pins follow `docs/hardware-brief.md` section 3.

**Valve interlock is on** (`valve.interlock_min_open_zones` = 1). There is no bypass, so
closing the last open valve while the pump runs would dead-head it. The web app lets an
operator override it only after confirming the pump is off.

## Set it up on Neon

1. Create a project at neon.com. Pick the region the backend will run in
   (Frankfurt if the backend is on Render's Frankfurt region).
2. Open **SQL Editor**, paste `001_schema.sql`, run it. Then `002_seed.sql`.
3. Create a branch called `dev` (Branches → New branch). Use `dev` while
   testing and keep `main` for presentations.
4. Copy the connection string from **Connect** (choose the pooled one). It goes
   into the backend's environment settings, never into Git.

When Zone B is plumbed and wired, run `rig/10_zone_b.sql` the same way.

## Before connecting the real rig

- Replace the placeholder MAC address of node-2 with the value the firmware prints at startup.
- GPIO pins in the seed must match `firmware/node/config.h`.
- `k_factor` 98 is the YF-S401 datasheet value. The calibration test adjusts it per sensor.
- Pressure: 100 PSI transducer, 0.5–4.5 V → `cal_offset` 0.5, `cal_scale` 172.37 kPa/V.
- If P1 isn't fitted yet: `UPDATE sensors SET active = false WHERE code = 'P1';`

## Running the tests locally (optional)

```bash
createdb sw_test
psql -d sw_test -f 001_schema.sql -f 002_seed.sql -f tests/test_current_rig.sql
```
