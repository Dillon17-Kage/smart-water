-- Adds Zone C on its own board, node-3 (design document node table).
--   F6  Zone C inlet flow      GPIO 21
--   F7  Zone C outlet flow     GPIO 22
--   P3  Zone C inlet pressure  GPIO 34 (ADC1)
--   SV3 Zone C solenoid        GPIO 27
-- Pins follow the pin plan in docs/hardware-brief.md section 3. They don't clash
-- with Zones A and B, so Zone C can go on node-2 instead if only one ESP32 is
-- used: change 'node-3' to 'node-2' below and skip the INSERT INTO nodes.
-- Replace the placeholder MAC with WiFi.macAddress() from the board.
-- The valve interlock is already on (002_seed.sql).

BEGIN;

UPDATE zones SET active = true WHERE code = 'C';

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-3', '02:00:00:00:00:03', 'sw-node-3');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F6', 'zone_inlet',  21),
    ('F7', 'zone_outlet', 22)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-3'
JOIN zones z ON z.code = 'C';

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT 'P3', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 34, 0.5, 172.37, -20, 700
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'C';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV3', n.id, z.id, 27
FROM nodes n, zones z
WHERE n.name = 'node-3' AND z.code = 'C';

COMMIT;
