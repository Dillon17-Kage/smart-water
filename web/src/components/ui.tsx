import { AlertTriangle, CheckCircle2, CircleSlash, Lock, OctagonAlert, WifiOff, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ZoneStatus } from '../lib/rig';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ layout pieces

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function StatTile({ label, value, unit, hint, tone }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium text-ink-2">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tracking-tight', tone ? toneText[tone] : 'text-ink')}>
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-ink-2">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ status

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'accent';

export const toneText: Record<Tone, string> = {
  good: 'text-good-ink',
  warning: 'text-warning-ink',
  serious: 'text-serious-ink',
  critical: 'text-critical-ink',
  neutral: 'text-ink-2',
  accent: 'text-accent',
};

const toneChip: Record<Tone, string> = {
  good: 'bg-good-soft text-good-ink',
  warning: 'bg-warning-soft text-warning-ink',
  serious: 'bg-serious-soft text-serious-ink',
  critical: 'bg-critical-soft text-critical-ink',
  neutral: 'bg-neutral-soft text-ink-2',
  accent: 'bg-accent-soft text-accent',
};

export function Chip({ tone, icon: Icon, children }: { tone: Tone; icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', toneChip[tone])}>
      {Icon && <Icon size={13} strokeWidth={2.25} aria-hidden />}
      {children}
    </span>
  );
}

export const zoneStatusInfo: Record<ZoneStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  normal: { label: 'Normal', tone: 'good', icon: CheckCircle2 },
  suspected: { label: 'Leak suspected', tone: 'warning', icon: AlertTriangle },
  leak: { label: 'Leak confirmed', tone: 'critical', icon: OctagonAlert },
  isolated: { label: 'Isolated', tone: 'neutral', icon: Lock },
  offline: { label: 'No data', tone: 'serious', icon: WifiOff },
  inactive: { label: 'Not built', tone: 'neutral', icon: CircleSlash },
};

export function ZoneStatusChip({ status }: { status: ZoneStatus }) {
  const info = zoneStatusInfo[status];
  return (
    <Chip tone={info.tone} icon={info.icon}>
      {info.label}
    </Chip>
  );
}

// ------------------------------------------------------------------ controls

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
const buttonVariant: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
  danger: 'bg-critical text-white hover:opacity-90',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        buttonVariant[variant],
        className,
      )}
    />
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-2 text-sm text-ink-2">{children}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? 'Sending…' : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------------ hooks

/** Re-render every `ms` so "x seconds ago" labels stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-2" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      {label}
    </div>
  );
}
