import { FlaskConical, Plug, Unplug, X } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { simulator } from '../data/mock/mockSource';
import { stage } from '../data/mock/rig';
import { useLiveData } from '../state/LiveDataContext';
import { Button, cx } from './ui';

/**
 * Test controls for the in-browser simulator: open a leak point, unplug a node.
 * Only shown when VITE_DATA_SOURCE is 'mock'. This stands in for physically
 * opening a leak valve on the rig, so you can test the UI before the hardware works.
 */
export function SimulatorPanel() {
  const [open, setOpen] = useState(false);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const { rig, nodes } = useLiveData();
  const [rates, setRates] = useState<Record<number, number>>({ 1: 0.4, 2: 0.4, 3: 0.4 });

  useEffect(() => simulator.onControlsChange(rerender), []);

  const anyLeak = rig?.zones.some((z) => simulator.getLeak(z.id) > 0);

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium shadow-lg transition',
          anyLeak ? 'border-warning bg-warning-soft text-warning-ink' : 'border-line-strong bg-surface text-ink hover:bg-surface-2',
        )}
        aria-expanded={open}
      >
        <FlaskConical size={16} aria-hidden />
        Simulator
      </button>

      {open && rig && (
        <div className="fixed bottom-16 right-4 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Rig simulator</div>
              <div className="text-xs text-ink-2">Test tool, not part of the real system · stage: {stage}</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-ink-3 hover:text-ink" aria-label="Close simulator">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-4 p-4">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Leak points</h3>
              <div className="space-y-3">
                {rig.zones
                  .filter((z) => z.active)
                  .map((zone) => {
                    const leaking = simulator.getLeak(zone.id) > 0;
                    const rate = rates[zone.id] ?? 0.4;
                    return (
                      <div key={zone.id} className="rounded-lg border border-line p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{zone.name}</span>
                          <Button
                            size="sm"
                            variant={leaking ? 'secondary' : 'danger'}
                            onClick={() => simulator.setLeak(zone.id, leaking ? 0 : rate)}
                          >
                            {leaking ? 'Close leak' : 'Open leak'}
                          </Button>
                        </div>
                        <label className="mt-2 flex items-center gap-3 text-xs text-ink-2">
                          <span className="w-20 tabular">{rate.toFixed(2)} L/min</span>
                          <input
                            type="range"
                            min={0.05}
                            max={0.6}
                            step={0.05}
                            value={rate}
                            onChange={(e) => {
                              const value = Number(e.target.value);
                              setRates((r) => ({ ...r, [zone.id]: value }));
                              if (leaking) simulator.setLeak(zone.id, value);
                            }}
                            className="flex-1 accent-[var(--accent)]"
                            aria-label={`${zone.name} leak rate`}
                          />
                        </label>
                      </div>
                    );
                  })}
              </div>
              <p className="mt-2 text-xs text-ink-3">
                A leak below {rig.settings.residualThreshold} L/min stays under the detection threshold. Confirmation takes{' '}
                {rig.settings.confirmSeconds} s.
              </p>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Nodes</h3>
              <div className="space-y-1.5">
                {nodes.map((node) => {
                  const unplugged = simulator.isNodeUnplugged(node.id);
                  return (
                    <div key={node.id} className="flex items-center justify-between text-sm">
                      <span>
                        {node.name} <span className="text-xs text-ink-3">({node.status})</span>
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => simulator.setNodeUnplugged(node.id, !unplugged)}>
                        {unplugged ? <Plug size={14} aria-hidden /> : <Unplug size={14} aria-hidden />}
                        {unplugged ? 'Reconnect' : 'Unplug'}
                      </Button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-ink-3">An unplugged node is reported offline after {rig.settings.heartbeatTimeoutSeconds} s without a heartbeat.</p>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
