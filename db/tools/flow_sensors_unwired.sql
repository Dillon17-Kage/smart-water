-- Switches off flow sensors that aren't wired yet. An unwired flow pin picks up noise
-- (about 100 pulses/s, roughly 1 L/min), and the difference between a zone's two noisy
-- pins can look like a leak. While off, the backend rejects their readings as
-- unknown_sensor and skips the zone in leak detection.
--
-- The noise stops once the 12k/22k divider is soldered on (the 22k holds the pin at 0 V).
-- Switch a pair back on when it's wired:
--   UPDATE sensors SET active = true WHERE code IN ('F4', 'F5');
-- The backend reads this at startup, so restart it afterwards (Render: Manual Deploy >
-- Restart service, or any push).

BEGIN;

UPDATE sensors SET active = false WHERE code IN ('F4', 'F5', 'F6', 'F7');

COMMIT;
