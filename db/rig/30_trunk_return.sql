-- Adds node-1 at the tank: whole-network reconciliation (F1 vs F8).
--   F1  trunk flow       GPIO 18
--   F8  return flow      GPIO 19
-- There are no trunk or return pressure sensors: the rig has only the three
-- zone inlet sensors P1-P3. The schema still allows them, so one can be added
-- later with the same INSERT as P1, position 'trunk' or 'return' and code P4.
-- Replace the placeholder MAC with WiFi.macAddress() from the board.

BEGIN;

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-1', '02:00:00:00:00:01', 'sw-node-1');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, NULL, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F1', 'trunk',  18),
    ('F8', 'return', 19)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-1';

COMMIT;
