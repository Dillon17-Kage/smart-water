-- Adds node-1 at the tank: whole-network reconciliation (F1 vs F5) and
-- trunk/return pressure.
--   F1  trunk flow       GPIO 25
--   F5  return flow      GPIO 26
--   P1  trunk pressure   GPIO 34 (ADC1)
--   P5  return pressure  GPIO 35 (ADC1)
-- Replace the placeholder MAC with WiFi.macAddress() from the board.

BEGIN;

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-1', '02:00:00:00:00:01', 'sw-node-1');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, NULL, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F1', 'trunk',  25),
    ('F5', 'return', 26)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-1';

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT v.code, n.id, NULL, 'pressure', v.position, 'kPa', v.pin, 0.5, 172.37, -20, 700
FROM (VALUES
    ('P1', 'trunk',  34),
    ('P5', 'return', 35)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-1';

COMMIT;
