import { AlertTriangle, Check, CheckCheck, Info, OctagonAlert } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Chip, cx, PageHeader, useNow, type Tone } from '../components/ui';
import { formatAgo, formatDateTime, formatDuration, formatTime } from '../lib/format';
import { useAuth } from '../state/AuthContext';
import { useLiveData } from '../state/LiveDataContext';
import type { Alert, AlertType, LeakEvent, Rig } from '../types';

const typeLabel: Record<AlertType, string> = {
  leak: 'Leak',
  node_offline: 'Node offline',
  sensor_fault: 'Sensor fault',
  valve_failure: 'Valve failure',
};

const severityInfo = {
  critical: { tone: 'critical' as Tone, icon: OctagonAlert, label: 'Critical' },
  warning: { tone: 'warning' as Tone, icon: AlertTriangle, label: 'Warning' },
  info: { tone: 'accent' as Tone, icon: Info, label: 'Info' },
};

const leakStatusLabel: Record<LeakEvent['status'], { label: string; tone: Tone }> = {
  suspected: { label: 'Suspected', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'critical' },
  resolved: { label: 'Resolved', tone: 'good' },
  false_alarm: { label: 'False alarm', tone: 'neutral' },
};

type Filter = 'active' | 'resolved' | 'all';

export function AlertsPage() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const [filter, setFilter] = useState<Filter>('active');
  useNow();

  const visible = live.alerts.filter((a) =>
    filter === 'all' ? true : filter === 'resolved' ? a.status === 'resolved' : a.status !== 'resolved',
  );
  const counts = {
    active: live.alerts.filter((a) => a.status !== 'resolved').length,
    resolved: live.alerts.filter((a) => a.status === 'resolved').length,
    all: live.alerts.length,
  };

  return (
    <>
      <PageHeader title="Alerts" subtitle="Leaks, offline nodes, sensor faults and valve failures, newest first.">
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-sm" role="group" aria-label="Filter alerts">
          {(['active', 'resolved', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cx('rounded-md px-3 py-1 capitalize', filter === f ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:text-ink')}
            >
              {f} <span className="tabular text-ink-3">{counts[f]}</span>
            </button>
          ))}
        </div>
      </PageHeader>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-2">
          {filter === 'active' ? 'No active alerts. The network is behaving normally.' : 'Nothing to show.'}
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </ul>
      )}

      <div className="mt-8">
        <Card title="Leak history">
          {live.leakEvents.length === 0 ? (
            <p className="text-sm text-ink-2">No leaks recorded yet.</p>
          ) : (
            <div className="-mx-4 -my-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="px-4 py-2 font-medium">Zone</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Detected</th>
                    <th className="px-2 py-2 font-medium">Duration</th>
                    <th className="px-2 py-2 text-right font-medium">Peak rate</th>
                    <th className="px-2 py-2 text-right font-medium">Water lost</th>
                    <th className="px-4 py-2 text-right font-medium">Pressure drop</th>
                  </tr>
                </thead>
                <tbody>
                  {live.leakEvents.map((e) => {
                    const status = leakStatusLabel[e.status];
                    return (
                      <tr key={e.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 font-medium">{rig.zones.find((z) => z.id === e.zoneId)?.name ?? 'Network'}</td>
                        <td className="px-2 py-2">
                          <Chip tone={status.tone}>{status.label}</Chip>
                        </td>
                        <td className="px-2 py-2 text-ink-2">{formatDateTime(e.detectedAt)}</td>
                        <td className="px-2 py-2 tabular text-ink-2">{formatDuration(e.detectedAt, e.resolvedAt)}</td>
                        <td className="px-2 py-2 text-right tabular">{e.peakResidual.toFixed(2)} L/min</td>
                        <td className="px-2 py-2 text-right tabular">{e.volumeLost.toFixed(2)} L</td>
                        <td className="px-4 py-2 text-right tabular">{e.pressureDrop.toFixed(1)} kPa</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const { can } = useAuth();
  const [busy, setBusy] = useState<'ack' | 'resolve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const severity = severityInfo[alert.severity];
  const event = alert.leakEventId ? live.leakEvents.find((e) => e.id === alert.leakEventId) : undefined;
  const zone = event ? rig.zones.find((z) => z.id === event.zoneId) : undefined;
  const resolved = alert.status === 'resolved';

  const run = async (kind: 'ack' | 'resolve') => {
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'ack' ? live.acknowledgeAlert(alert.id) : live.resolveAlert(alert.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <li
      className={cx(
        'rounded-xl border bg-surface p-4',
        resolved ? 'border-line opacity-75' : alert.severity === 'critical' ? 'border-critical/50' : 'border-warning/60',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <severity.icon size={20} className={cx('mt-0.5 shrink-0', resolved ? 'text-ink-3' : alert.severity === 'critical' ? 'text-critical' : 'text-warning-ink')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{typeLabel[alert.type]}</span>
            <Chip tone={resolved ? 'neutral' : severity.tone}>{severity.label}</Chip>
            <Chip tone={alert.status === 'open' ? 'critical' : alert.status === 'acknowledged' ? 'accent' : 'good'}>
              {alert.status === 'open' ? 'Open' : alert.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
            </Chip>
          </div>
          <p className="mt-1 text-sm text-ink">{alert.message}</p>

          {event && (
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-ink-3">Estimated zone</dt>
                <dd className="font-medium">{zone?.name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Loss rate</dt>
                <dd className="font-medium tabular">{event.lossRate.toFixed(2)} L/min</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Water lost</dt>
                <dd className="font-medium tabular">{event.volumeLost.toFixed(2)} L</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-3">Started</dt>
                <dd className="font-medium">{formatTime(event.detectedAt)}</dd>
              </div>
            </dl>
          )}

          <p className="mt-3 text-xs text-ink-3">
            Raised {formatDateTime(alert.createdAt)} ({formatAgo(alert.createdAt)})
            {alert.acknowledgedBy && ` · acknowledged by ${alert.acknowledgedBy} at ${formatTime(alert.acknowledgedAt)}`}
            {alert.resolvedAt && ` · resolved at ${formatTime(alert.resolvedAt)}`}
          </p>
          {error && <p className="mt-2 text-sm text-critical-ink" role="alert">{error}</p>}
        </div>

        {!resolved && (
          <div className="flex gap-2">
            {alert.status === 'open' && can('alerts.acknowledge') && (
              <Button size="sm" onClick={() => run('ack')} disabled={!!busy}>
                <Check size={14} aria-hidden />
                {busy === 'ack' ? 'Saving…' : 'Acknowledge'}
              </Button>
            )}
            {can('alerts.resolve') && (
              <Button size="sm" variant="ghost" onClick={() => run('resolve')} disabled={!!busy}>
                <CheckCheck size={14} aria-hidden />
                {busy === 'resolve' ? 'Saving…' : 'Resolve'}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
