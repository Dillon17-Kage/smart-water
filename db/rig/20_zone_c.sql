-- Adds Zone C on its own board, node-3 (design document node table).
--   F4  Zone C inlet flow      GPIO 25
--   F8  Zone C outlet flow     GPIO 26
--   P4  Zone C inlet pressure  GPIO 34 (ADC1)
--   SV3 Zone C solenoid        GPIO 23
-- With three zones and no reliance on the bypass, switch the interlock on.
-- Replace the placeholder MAC with WiFi.macAddress() from the board.

BEGIN;

UPDATE zones SET active = true WHERE code = 'C';

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-3', '02:00:00:00:00:03', 'sw-node-3');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F4', 'zone_inlet',  25),
    ('F8', 'zone_outlet', 26)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-3'
JOIN zones z ON z.code = 'C';

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT 'P4', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 34, 0.5, 172.37, -20, 700
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'C';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV3', n.id, z.id, 23
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'C';

UPDATE settings SET value = '1', updated_at = now()
WHERE key = 'valve.interlock_min_open_zones';

COMMIT;
