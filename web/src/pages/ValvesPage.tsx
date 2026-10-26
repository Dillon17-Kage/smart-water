import { Lock, Unlock, WifiOff } from 'lucide-react';
import { CommandResult } from '../components/CommandResult';
import { Button, Card, Chip, PageHeader, useNow, type Tone } from '../components/ui';
import { useValveControl } from '../components/ValveControl';
import { formatAgo, formatDateTime } from '../lib/format';
import { openLeakFor } from '../lib/rig';
import { useAuth } from '../state/AuthContext';
import { useLiveData } from '../state/LiveDataContext';
import type { CommandStatus, Rig } from '../types';

const commandStatus: Record<CommandStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'accent' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  timed_out: { label: 'Timed out', tone: 'serious' },
  rejected: { label: 'Rejected', tone: 'critical' },
};

export function ValvesPage() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const { can } = useAuth();
  const now = useNow();
  const control = useValveControl();
  const canOperate = can('valves.operate');

  return (
    <>
      <PageHeader
        title="Valves"
        subtitle={
          canOperate
            ? 'Open or close the solenoid valve on each zone. Every command is confirmed by the node.'
            : 'Current state of each zone valve. Your role can view valves but not operate them.'
        }
      />
      <CommandResult result={control.result} onClose={control.clearResult} />

      <div className="grid gap-3 md:grid-cols-2">
        {live.valves.map((valve) => {
          const zone = rig.zones.find((z) => z.id === valve.zoneId);
          const node = live.nodes.find((n) => n.id === valve.nodeId);
          const inFlight = live.commands.some((c) => c.valveId === valve.id && (c.status === 'pending' || c.status === 'sent'));
          const last = live.commands.find((c) => c.valveId === valve.id);
          const leak = openLeakFor(valve.zoneId, live.leakEvents);
          const closed = valve.state === 'closed';
          return (
            <div key={valve.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">{valve.code}</div>
                  <div className="text-sm text-ink-2">
                    {zone?.name} supply · {node?.name}
                  </div>
                </div>
                <Chip tone={closed ? 'neutral' : 'accent'} icon={closed ? Lock : Unlock}>
                  {closed ? 'Closed' : valve.state === 'open' ? 'Open' : 'Unknown'}
                </Chip>
              </div>

              <div className="mt-3 space-y-1 text-sm">
                {node?.status === 'offline' && (
                  <p className="flex items-center gap-1.5 text-serious-ink">
                    <WifiOff size={14} aria-hidden /> Node offline since {formatAgo(node.lastSeen, now)}. Commands can't be delivered.
                  </p>
                )}
                {leak && !closed && (
                  <p className="font-medium text-critical-ink">
                    {leak.status === 'confirmed' ? 'Leak confirmed' : 'Possible leak'} in this zone. Closing the valve isolates it.
                  </p>
                )}
                {leak && closed && <p className="text-ink-2">Zone isolated while a leak is open.</p>}
                <p className="text-xs text-ink-3">
                  {last
                    ? `Last command: ${last.action} by ${last.issuedBy ?? 'system'}, ${formatAgo(last.issuedAt, now)} (${commandStatus[last.status].label.toLowerCase()})`
                    : 'No commands sent yet.'}
                </p>
              </div>

              {canOperate && (
                <Button
                  className="mt-4 w-full"
                  variant={closed ? 'primary' : leak ? 'danger' : 'secondary'}
                  disabled={inFlight}
                  onClick={() => control.request(valve)}
                >
                  {inFlight ? 'Waiting for node…' : closed ? `Open ${valve.code}` : `Close ${valve.code}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <Card title="Command log">
          {live.commands.length === 0 ? (
            <p className="text-sm text-ink-2">No valve commands yet.</p>
          ) : (
            <div className="-mx-4 -my-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="px-4 py-2 font-medium">Issued</th>
                    <th className="px-2 py-2 font-medium">Valve</th>
                    <th className="px-2 py-2 font-medium">Action</th>
                    <th className="px-2 py-2 font-medium">By</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {live.commands.map((c) => {
                    const valve = live.valves.find((v) => v.id === c.valveId);
                    const status = commandStatus[c.status];
                    const latency = c.confirmedAt ? ((Date.parse(c.confirmedAt) - Date.parse(c.issuedAt)) / 1000).toFixed(1) : null;
                    return (
                      <tr key={c.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 whitespace-nowrap text-ink-2">{formatDateTime(c.issuedAt)}</td>
                        <td className="px-2 py-2 font-medium">{valve?.code}</td>
                        <td className="px-2 py-2 capitalize">{c.action}</td>
                        <td className="px-2 py-2 text-ink-2">{c.issuedBy ?? 'system'}</td>
                        <td className="px-2 py-2">
                          <Chip tone={status.tone}>{status.label}</Chip>
                        </td>
                        <td className="px-4 py-2 text-ink-2">
                          {c.rejectReason ?? (latency ? `Confirmed in ${latency} s` : c.status === 'timed_out' ? 'No acknowledgement from the node' : '')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {control.dialog}
    </>
  );
}
