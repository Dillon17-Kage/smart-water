-- P1 as built: with no pressure the real sensor read 0.38 V, not the datasheet's 0.5 V
-- (firmware/RESULTS.md, measured on USB power). PROVISIONAL: measure it again on the
-- final 5.0 V supply with the calibration page or the firmware's `zero P1`.
--
-- The lower limit stays at -20 kPa on purpose. A disconnected P1 reads about 0.22 V
-- (the ADC floor), which is about -28 kPa with this offset, so it's rejected as
-- out_of_range and never looks like a real pressure.

BEGIN;

UPDATE sensors SET cal_offset = 0.38, min_valid = -20 WHERE code = 'P1';

COMMIT;
