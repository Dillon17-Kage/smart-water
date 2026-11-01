import { useState } from 'react';
import { useLiveData } from '../state/LiveDataContext';
import type { Valve, ValveAction, ValveCommand } from '../types';
import { ConfirmDialog } from './ui';

/**
 * Shared confirm-then-send flow for valve commands, used by the Valves page
 * and the network schematic. Closing a valve cuts water to a whole zone, so
 * every command is confirmed first.
 *
 * Closing the last open zone would dead-head the pump, so the interlock refuses
 * it. If the operator ticks "the pump is off", the command goes out with
 * force = true and the backend (and the node) skip the interlock.
 */
export function useValveControl() {
  const live = useLiveData();
  const [pending, setPending] = useState<{ valve: Valve; action: ValveAction } | null>(null);
  const [pumpOff, setPumpOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ command?: ValveCommand; error?: string } | null>(null);

  const request = (valve: Valve) => {
    setResult(null);
    setPumpOff(false);
    setPending({ valve, action: valve.state === 'closed' ? 'open' : 'close' });
  };

  const zoneName = (valve: Valve) => live.rig?.zones.find((z) => z.id === valve.zoneId)?.name ?? 'the zone';

  // Same rule as the backend: count the zones that would still have an open valve.
  const leavesTooFewOpen = (valve: Valve) => {
    const minOpen = live.rig?.settings.interlockMinOpenZones ?? 0;
    const openZones = new Set(live.valves.filter((v) => v.id !== valve.id && v.state === 'open').map((v) => v.zoneId));
    return openZones.size < minOpen;
  };
  const needsPumpOff = pending?.action === 'close' && pending.valve.state !== 'closed' && leavesTooFewOpen(pending.valve);

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `${pending.action === 'close' ? 'Close' : 'Open'} ${pending.valve.code}?` : ''}
      confirmLabel={pending?.action === 'close' ? 'Close valve' : 'Open valve'}
      danger={pending?.action === 'close'}
      busy={busy}
      confirmDisabled={needsPumpOff && !pumpOff}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        if (!pending) return;
        setBusy(true);
        try {
          const command = await live.sendValveCommand(pending.valve.id, pending.action, needsPumpOff && pumpOff);
          setResult({ command });
        } catch (error) {
          setResult({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy(false);
          setPending(null);
        }
      }}
    >
      {pending?.action === 'close' ? (
        <>
          <p>
            This shuts off all water to <strong>{zoneName(pending.valve)}</strong>. Use it to isolate a leak. Leak detection
            pauses for the zone while it's closed.
          </p>
          {needsPumpOff && (
            <div className="mt-3 rounded-lg border border-serious/50 bg-serious-soft p-3 text-serious-ink">
              <p>
                <strong>No other zone is open.</strong> Closing {pending.valve.code} leaves the pump with nowhere to push
                water, which can damage it. Switch the pump off first.
              </p>
              <label className="mt-2 flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-current"
                  checked={pumpOff}
                  onChange={(e) => setPumpOff(e.target.checked)}
                />
                I have confirmed the pump is off
              </label>
            </div>
          )}
        </>
      ) : (
        pending && (
          <p>
            This restores water to <strong>{zoneName(pending.valve)}</strong>. If a leak was isolated, make sure it has been
            repaired first.
          </p>
        )
      )}
    </ConfirmDialog>
  );

  return { request, dialog, result, clearResult: () => setResult(null) };
}
