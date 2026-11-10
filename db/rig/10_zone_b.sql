-- Adds node-3 and Zone B (one board per zone).
--   F4  Zone B inlet flow      GPIO 16
--   F5  Zone B outlet flow     GPIO 17
--   P2  Zone B inlet pressure  GPIO 33 (ADC1)
--   SV2 Zone B solenoid        GPIO 25 (normally closed, through a relay)
-- These match firmware/node/config.h. The MAC is the real board's.
-- Run once, after 002_seed.sql.

BEGIN;

UPDATE zones SET active = true WHERE code = 'B';

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-3', '8c:94:df:6c:a3:10', 'sw-node-3');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F4', 'zone_inlet',  16),
    ('F5', 'zone_outlet', 17)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-3'
JOIN zones z ON z.code = 'B';

-- Zero 0.5 V from the datasheet until it is measured on the Calibration page.
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT 'P2', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 33, 0.5, 172.37, -20, 700
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'B';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV2', n.id, z.id, 25
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'B';

COMMIT;
