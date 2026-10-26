-- Clears test data before a presentation: readings, leak events, alerts and
-- valve commands. Keeps users, the rig configuration, baselines, settings and
-- maintenance records.
--
-- Run it in the Neon SQL editor (or psql) on the branch you will present from.

BEGIN;

TRUNCATE readings, rejected_readings, alerts, leak_events, valve_commands RESTART IDENTITY;

UPDATE valves SET state = 'unknown', state_changed_at = NULL;
UPDATE nodes  SET status = 'unknown', last_seen = NULL;

COMMIT;
