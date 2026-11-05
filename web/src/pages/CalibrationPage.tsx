import { useState } from 'react';
import { Button, Card, ConfirmDialog, PageHeader, useNow } from '../components/ui';
import { dataSource } from '../data';
import { zoneSensors } from '../lib/rig';
import { useLiveData } from '../state/LiveDataContext';
import type { Rig, Sensor, Zone } from '../types';

/** What the confirm dialog is about to do. */
type Pending = { kind: 'baseline'; zone: Zone } | { kind: 'zero'; sensor: Sensor };

/**
 * The two calibrations the rig needs before leak detection can be trusted:
 *   - flow baseline: two cheap flow sensors never agree exactly, so record their normal
 *     difference with no leak, and detection subtracts it
 *   - pressure zero: what a pressure sensor reads with no pressure
 * The backend does the sums from the readings it has stored, so a sensor that isn't
 * connected or isn't sending gets a clear refusal instead of a wrong calibration.
 */
export function CalibrationPage() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const now = useNow();

  // Only a recent reading counts: an old one may be from before the sensor stopped sending.
  const value = (sensor: Sensor | undefined) => {
    const reading = sensor ? live.latest[sensor.id] : undefined;
    return reading && now - Date.parse(reading.recordedAt) < 15_000 ? reading.value : undefined;
  };
  const show = (n: number | undefined, unit: string) => (n === undefined ? 'No recent reading' : `${n.toFixed(2)} ${unit}`);

  const run = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'baseline') {
        const b = await live.recordBaseline(pending.zone.id);
        setResult({
          ok: true,
          text: `${pending.zone.name} baseline recorded: the flow sensors normally differ by ${b.flowOffset.toFixed(3)} L/min.`,
        });
      } else {
        const z = await dataSource.zeroPressureSensor(pending.sensor.id);
        setResult({ ok: true, text: `${z.sensor} zero set to ${z.zeroVolts.toFixed(3)} V.` });
      }
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const activeZones = rig.zones.filter((z) => z.active);

  return (
    <>
      <PageHeader title="Calibration" subtitle="Run these once the rig is built and filled, and again if a sensor is replaced." />

      {result && (
        <p
          role="status"
          className={`mb-4 rounded-lg border p-3 text-sm ${result.ok ? 'border-line bg-surface' : 'border-serious/50 bg-serious-soft text-serious-ink'}`}
        >
          {result.text}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {activeZones.map((zone) => {
          const { inlet, outlet, pressure } = zoneSensors(rig, zone.id);
          const baseline = rig.baselines.find((b) => b.zoneId === zone.id);
          return (
            <Card key={zone.id} title={`${zone.name} flow baseline`}>
              <p className="text-sm text-ink-2">
                Shut every leak point, run the pump and keep the valve open for a minute, then record.
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><dt>{inlet?.code} inlet</dt><dd>{show(value(inlet), 'L/min')}</dd></div>
                <div className="flex justify-between"><dt>{outlet?.code} outlet</dt><dd>{show(value(outlet), 'L/min')}</dd></div>
                <div className="flex justify-between">
                  <dt>Recorded difference</dt>
                  <dd>{baseline ? `${baseline.flowOffset.toFixed(3)} L/min` : 'Not recorded yet'}</dd>
                </div>
              </dl>
              <Button className="mt-4 w-full" variant="secondary" onClick={() => { setResult(null); setPending({ kind: 'baseline', zone }); }}>
                Record baseline
              </Button>

              {pressure && (
                <div className="mt-5 border-t border-line pt-4">
                  <div className="font-semibold">{pressure.code} pressure zero</div>
                  <p className="mt-1 text-sm text-ink-2">Switch the pump off and let the pressure fall to nothing, then set the zero.</p>
                  <p className="mt-2 flex justify-between text-sm"><span>{pressure.code} now</span><span>{show(value(pressure), 'kPa')}</span></p>
                  <Button className="mt-4 w-full" variant="secondary" onClick={() => { setResult(null); setPending({ kind: 'zero', sensor: pressure }); }}>
                    Set zero
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === 'baseline' ? `Record the ${pending.zone.name} baseline?` : pending ? `Set the ${pending.sensor.code} zero?` : ''}
        confirmLabel={pending?.kind === 'baseline' ? 'Record baseline' : 'Set zero'}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={run}
      >
        {pending?.kind === 'baseline' ? (
          <p>Any leak open now would be treated as normal, and detection would then miss it. Check every leak point is shut.</p>
        ) : (
          <p>The pump must be off. Any pressure in the pipe now would be treated as zero, and every later reading would be too low.</p>
        )}
      </ConfirmDialog>
    </>
  );
}
