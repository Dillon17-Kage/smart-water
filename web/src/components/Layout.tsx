import { Bell, Droplets, LayoutDashboard, LogOut, Network, OctagonAlert, ToggleRight, AlertTriangle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { roleLabel, type Permission } from '../auth/permissions';
import { dataSource } from '../data';
import { formatDuration, formatTime } from '../lib/format';
import { useAuth } from '../state/AuthContext';
import { useLiveData } from '../state/LiveDataContext';
import type { Alert } from '../types';
import { SimulatorPanel } from './SimulatorPanel';
import { Button, cx, Spinner, useNow } from './ui';

const navItems: { to: string; label: string; icon: typeof Bell; permission: Permission }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.view' },
  { to: '/network', label: 'Network', icon: Network, permission: 'network.view' },
  { to: '/alerts', label: 'Alerts', icon: Bell, permission: 'alerts.view' },
  { to: '/valves', label: 'Valves', icon: ToggleRight, permission: 'valves.view' },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const live = useLiveData();
  const openAlerts = live.alerts.filter((a) => a.status === 'open').length;
  const items = navItems.filter((item) => can(item.permission));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2.5 md:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold text-ink">
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-ink">
              <Droplets size={18} aria-hidden />
            </span>
            <span className="hidden sm:inline">Smart Water</span>
          </Link>
          <ConnectionBadge />
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <div className="text-sm font-medium text-ink">{user?.fullName ?? user?.username}</div>
              <div className="text-xs text-ink-2">{user && roleLabel[user.role]}</div>
            </div>
            <Button variant="ghost" size="sm" onClick={logout} title="Sign out">
              <LogOut size={16} aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
        {/* Mobile navigation */}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden" aria-label="Main">
          {items.map((item) => (
            <NavItem key={item.to} {...item} badge={item.to === '/alerts' ? openAlerts : 0} compact />
          ))}
        </nav>
      </header>

      <div className="flex flex-1">
        <nav className="hidden w-52 shrink-0 flex-col gap-1 border-r border-line bg-surface p-3 md:flex" aria-label="Main">
          {items.map((item) => (
            <NavItem key={item.to} {...item} badge={item.to === '/alerts' ? openAlerts : 0} />
          ))}
          <div className="mt-auto px-2 pt-4 text-xs text-ink-3">
            Data: {dataSource.kind === 'mock' ? 'simulator' : 'live API'}
          </div>
        </nav>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7">
          <LeakBanner />
          {live.status === 'loading' && <Spinner label="Loading the network…" />}
          {live.status === 'error' && (
            <div className="rounded-xl border border-critical/40 bg-critical-soft p-4 text-sm text-critical-ink">
              <p className="font-medium">Couldn't load data from the server.</p>
              <p className="mt-1">{live.error}</p>
              <Button className="mt-3" onClick={live.reload}>
                Try again
              </Button>
            </div>
          )}
          {live.status === 'ready' && <Outlet />}
        </main>
      </div>

      <AlertToasts />
      {dataSource.kind === 'mock' && <SimulatorPanel />}
    </div>
  );
}

function NavItem({ to, label, icon: Icon, badge, compact }: (typeof navItems)[number] & { badge: number; compact?: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-lg text-sm font-medium transition',
          compact ? 'shrink-0 px-3 py-1.5' : 'px-3 py-2',
          isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      <Icon size={17} aria-hidden />
      {label}
      {badge > 0 && (
        <span className="ml-auto rounded-full bg-critical px-1.5 text-xs font-semibold text-white tabular" aria-label={`${badge} open`}>
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function ConnectionBadge() {
  const { connection } = useLiveData();
  const info = {
    live: { label: 'Live', dot: 'bg-good' },
    connecting: { label: 'Connecting', dot: 'bg-warning' },
    reconnecting: { label: 'Reconnecting', dot: 'bg-warning' },
    disconnected: { label: 'Disconnected', dot: 'bg-critical' },
  }[connection];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink-2" role="status">
      <span className={cx('size-2 rounded-full', info.dot, connection === 'live' && 'animate-pulse')} aria-hidden />
      {info.label}
    </span>
  );
}

/** Stays on screen on every page while any zone has an open leak. */
function LeakBanner() {
  const { leakEvents, rig, valves } = useLiveData();
  useNow();
  const open = leakEvents.filter((e) => e.status === 'suspected' || e.status === 'confirmed');
  if (!rig || open.length === 0) return null;

  return (
    <div className="mb-5 space-y-2">
      {open.map((e) => {
        const zone = rig.zones.find((z) => z.id === e.zoneId);
        const confirmed = e.status === 'confirmed';
        const isolated = valves.find((v) => v.zoneId === e.zoneId)?.state === 'closed';
        const Icon = confirmed ? OctagonAlert : AlertTriangle;
        return (
          <div
            key={e.id}
            role="alert"
            className={cx(
              'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-3 text-sm',
              confirmed ? 'border-critical/40 bg-critical-soft text-critical-ink' : 'border-warning/50 bg-warning-soft text-warning-ink',
            )}
          >
            <span className="flex items-center gap-2 font-semibold">
              <Icon size={18} aria-hidden />
              {confirmed ? 'Leak confirmed' : 'Possible leak'} in {zone?.name ?? 'the network'}
            </span>
            <span className="tabular">
              {isolated ? 'Zone isolated' : `${e.lossRate.toFixed(2)} L/min`} · {e.volumeLost.toFixed(2)} L lost · since {formatTime(e.detectedAt)} (
              {formatDuration(e.detectedAt)})
            </span>
            <Link to="/alerts" className="ml-auto font-medium underline underline-offset-2">
              View alerts
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/** Pops up briefly when the server pushes a new alert. */
function AlertToasts() {
  const { alerts, status } = useLiveData();
  const seen = useRef<Set<number> | null>(null);
  const [toasts, setToasts] = useState<Alert[]>([]);

  useEffect(() => {
    if (status !== 'ready') return;
    if (seen.current === null) {
      seen.current = new Set(alerts.map((a) => a.id));
      return;
    }
    const fresh = alerts.filter((a) => !seen.current!.has(a.id));
    if (fresh.length === 0) return;
    fresh.forEach((a) => seen.current!.add(a.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToasts((current) => [...fresh, ...current].slice(0, 3));
    const ids = fresh.map((a) => a.id);
    setTimeout(() => setToasts((current) => current.filter((t) => !ids.includes(t.id))), 8000);
  }, [alerts, status]);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-16 right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2" aria-live="assertive">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'flex items-start gap-3 rounded-xl border bg-surface p-3 text-sm shadow-lg',
            t.severity === 'critical' ? 'border-critical/50' : 'border-warning/60',
          )}
        >
          {t.severity === 'critical' ? (
            <OctagonAlert size={18} className="mt-0.5 shrink-0 text-critical" aria-hidden />
          ) : (
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-ink" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-ink">New {t.severity} alert</div>
            <div className="text-ink-2">{t.message}</div>
          </div>
          <button className="text-ink-3 hover:text-ink" onClick={() => setToasts((c) => c.filter((x) => x.id !== t.id))} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
