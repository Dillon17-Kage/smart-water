import { useState } from 'react';
import { useLiveData } from '../state/LiveDataContext';
import type { Valve, ValveAction, ValveCommand } from '../types';
import { ConfirmDialog } from './ui';

/**
 * Shared confirm-then-send flow for valve commands, used by the Valves page
 * and the network schematic. Closing a valve cuts water to a whole zone, so
 * every command is confirmed first.
 */
export function useValveControl() {
  const live = useLiveData();
  const [pending, setPending] = useState<{ valve: Valve; action: ValveAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ command?: ValveCommand; error?: string } | null>(null);

  const request = (valve: Valve) => {
    setResult(null);
    setPending({ valve, action: valve.state === 'closed' ? 'open' : 'close' });
  };

  const zoneName = (valve: Valve) => live.rig?.zones.find((z) => z.id === valve.zoneId)?.name ?? 'the zone';

  const dialog = (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `${pending.action === 'close' ? 'Close' : 'Open'} ${pending.valve.code}?` : ''}
      confirmLabel={pending?.action === 'close' ? 'Close valve' : 'Open valve'}
      danger={pending?.action === 'close'}
      busy={busy}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        if (!pending) return;
        setBusy(true);
        try {
          const command = await live.sendValveCommand(pending.valve.id, pending.action);
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
        <p>
          This shuts off all water to <strong>{zoneName(pending.valve)}</strong>. Use it to isolate a leak. Leak detection pauses
          for the zone while it's closed.
        </p>
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
