-- =====================================================================
-- Smart Water: seed data for the rig AS IT IS BUILT NOW
--
-- Current build: Zone A only, on node-2.
--   F2  Zone A inlet flow      GPIO 18
--   F3  Zone A outlet flow     GPIO 19
--   P1  Zone A inlet pressure  GPIO 32 (ADC1)
--   SV1 Zone A solenoid        GPIO 26 (normally closed)
-- These match the wiring in docs/hardware-brief.md section 3.
--
-- There is no bypass. Closing the last open valve while the pump runs would
-- dead-head the pump, so the valve interlock is on
-- (valve.interlock_min_open_zones = 1). The operator can override it only
-- after confirming the pump is off (force: true in docs/mqtt-contract.md).
--
-- As the rig grows, run the scripts in db/rig/ (data only, no schema change):
--   rig/10_zone_b.sql        Zone B on node-2: F4, F5, P2, SV2
--   rig/20_zone_c.sql        Zone C on node-3: F6, F7, P3, SV3
--   rig/30_trunk_return.sql  node-1 at the tank: F1, F8 (no trunk/return pressure)
--
-- !! Check before connecting the real rig !!
--   * node MAC addresses are placeholders: replace with WiFi.macAddress()
--   * GPIO pins must match the firmware's config.h and the wiring
--   * flow k_factor 98 is the YF-S401 datasheet value (5880 pulses/L);
--     the calibration test refines it per sensor
--   * pressure: 100 PSI (689.5 kPa) transducer, 0.5-4.5 V, so
--     cal_offset 0.5 V and cal_scale 172.37 kPa/V (sensor volts, after the
--     firmware undoes the resistor divider)
-- =====================================================================

BEGIN;

INSERT INTO roles (name) VALUES
    ('administrator'), ('operator'), ('technician'), ('engineer');

INSERT INTO zones (code, name, active) VALUES
    ('A', 'Zone A', true),
    ('B', 'Zone B', false),   -- rig/10_zone_b.sql switches it on
    ('C', 'Zone C', false);   -- rig/20_zone_c.sql switches it on

-- node-2 is the board that serves Zones A and B (design document node table)
INSERT INTO nodes (name, mac_address, mqtt_client_id) VALUES
    ('node-2', '02:00:00:00:00:02', 'sw-node-2');

-- Zone A flow sensors (YF-S401)
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, k_factor, min_valid, max_valid)
SELECT v.code, n.id, z.id, 'flow', v.position, 'L/min', v.pin, 98, 0, 10
FROM (VALUES
    ('F2', 'node-2', 'A', 'zone_inlet',  18),
    ('F3', 'node-2', 'A', 'zone_outlet', 19)
) AS v(code, node, zone, position, pin)
JOIN nodes n ON n.name = v.node
JOIN zones z ON z.code = v.zone;

-- Zone A inlet pressure (100 PSI transducer).
-- If it isn't fitted yet, change active to false so it doesn't show as "no data".
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, gpio_pin, cal_offset, cal_scale, min_valid, max_valid, active)
SELECT 'P1', n.id, z.id, 'pressure', 'zone_inlet', 'kPa', 32, 0.5, 172.37, -20, 700, true
FROM nodes n, zones z
WHERE n.name = 'node-2' AND z.code = 'A';

INSERT INTO valves (code, node_id, zone_id, gpio_pin)
SELECT 'SV1', n.id, z.id, 26
FROM nodes n, zones z
WHERE n.name = 'node-2' AND z.code = 'A';

-- Starting values; tune on the rig
INSERT INTO settings (key, value, description) VALUES
    ('detection.residual_threshold_lpm', '0.3',
     'Zone residual (inlet - outlet - offset) above this counts as a possible leak, L/min'),
    ('detection.confirmation_period_s', '10',
     'Residual must stay above threshold this long before a leak is confirmed (ignores pump start / valve transients)'),
    ('detection.clear_period_s', '10',
     'Residual must stay below threshold this long before a leak is resolved'),
    ('detection.network_threshold_lpm', '0.4',
     'Trunk (F1) minus return (F8) above this counts as network-level loss, L/min. Used once node-1 is fitted'),
    ('health.heartbeat_timeout_s', '30',
     'Node marked offline after this long with no message'),
    ('valve.confirm_timeout_s', '5',
     'Valve command marked timed_out if the node has not acknowledged by then'),
    ('valve.interlock_min_open_zones', '1',
     'A close command is refused if it would leave fewer open zones than this, unless an operator confirms the pump is off. 1 because there is no bypass: closing the last valve would dead-head the pump'),
    ('auth.max_failed_logins', '5', 'Account locks after this many failed logins'),
    ('auth.lockout_minutes', '15', 'How long a locked account stays locked');

COMMIT;
