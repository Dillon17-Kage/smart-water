-- Adds node-4 and Zone C (one board per zone).
--   F6  Zone C inlet flow      GPIO 5
--   F7  Zone C outlet flow     GPIO 6
--   P3  Zone C inlet pressure  GPIO 3 (ADC1)
--   SV3 Zone C solenoid        GPIO 7
-- node-4 is an ESP32-C3 SuperMini, so its pins differ from node-2 and node-3.
-- These match firmware/node/config.h.
-- Run it only once the board exists: an active node that never connects raises a
-- node_offline alert. Replace the placeholder MAC with WiFi.macAddress() first.

BEGIN;

UPDATE zones SET active = true WHERE code = 'C';

INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-4', '02:00:00:00:00:04', 'sw-node-4');

INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F6', 'zone_inlet',  5),
    ('F7', 'zone_outlet', 6)
) AS v(code, position, pin)
JOIN nodes n ON n.name = 'node-4'
JOIN zones z ON z.code = 'C';

-- Zero 0.5 V from the datasheet until it is measured on the Calibration page.
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid)
SELECT 'P3', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 3, 0.5, 172.37, -20, 700
FROM nodes n, zones z
WHERE n.name = 'node-4' AND z.code = 'C';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV3', n.id, z.id, 7
FROM nodes n, zones z
WHERE n.name = 'node-4' AND z.code = 'C';

COMMIT;
