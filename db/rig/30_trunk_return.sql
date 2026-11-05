-- Adds the trunk and return flow sensors to node-2, for whole-network
-- reconciliation (F1 vs F8):
--   F1  trunk flow       GPIO 4
--   F8  return flow      GPIO 14
-- These match firmware/node/config.h. They were planned for a separate node-1 at
-- the tank, but sit on node-2 with Zone A on the rig as built.
-- There are no trunk or return pressure sensors: the rig has only the three
-- zone inlet sensors P1-P3. The schema still allows them, so one can be added
-- later with the same INSERT as P1, position 'trunk' or 'return' and code P4.

BEGIN;

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, NULL, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F1', 'trunk',  4),
    ('F8', 'return', 14)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-2';

COMMIT;
