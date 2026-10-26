# Smart Water database (PostgreSQL 16+, hosted on Neon)

| File | What it does |
|---|---|
| `001_schema.sql` | All tables, constraints, indexes and two views |
| `002_seed.sql` | Roles, zones, settings and the hardware **as built now**: Zone A on node-2 (F2, F6, P2, SV1) |
| `rig/10_zone_b.sql` | Adds Zone B to node-2 (F3, F7, P3, SV2) |
| `rig/20_zone_c.sql` | Adds node-3 and Zone C (F4, F8, P4, SV3) and switches the valve interlock on |
| `rig/30_trunk_return.sql` | Adds node-1 at the tank (F1, F5, P1, P5) |
| `tools/reset_demo_data.sql` | Clears readings, leaks, alerts and commands before a presentation |
| `tests/test_current_rig.sql` | Simulated 0.4 L/min leak in Zone A on the current rig; rolls back |
| `tests/test_full_rig.sql` | Simulated 0.8 L/min leak in Zone B on the full rig, plus constraint checks; rolls back |

Numbering follows the design document: F1 trunk, F5 return, F2–F4 zone inlets,
F6–F8 zone outlets, P1 trunk, P2–P4 zone inlets, P5 return.

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
- If P2 isn't fitted yet: `UPDATE sensors SET active = false WHERE code = 'P2';`

## Running the tests locally (optional)

```bash
createdb sw_test
psql -d sw_test -f 001_schema.sql -f 002_seed.sql -f tests/test_current_rig.sql
```
