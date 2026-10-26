-- Adds Zone B to node-2 (design document: node-2 serves Zones A and B).
--   F3  Zone B inlet flow      GPIO 27
--   F7  Zone B outlet flow     GPIO 14
--   P3  Zone B inlet pressure  GPIO 35 (ADC1)
--   SV2 Zone B solenoid        GPIO 22
-- Run once, after 002_seed.sql, when Zone B is plumbed and wired.

BEGIN;

UPDATE zones SET active = true WHERE code = 'B';

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F3', 'zone_inlet',  27),
    ('F7', 'zone_outlet', 14)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-2'
JOIN zones z ON z.code = 'B';

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT 'P3', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 35, 0.5, 172.37, -20, 700
FROM nodes n, zones z
WHERE n.name = 'node-2' AND z.code = 'B';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV2', n.id, z.id, 22
FROM nodes n, zones z
WHERE n.name = 'node-2' AND z.code = 'B';

COMMIT;
