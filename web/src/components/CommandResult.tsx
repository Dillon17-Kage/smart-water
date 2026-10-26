import { Ban, CheckCircle2, Clock, Loader2, X } from 'lucide-react';
import { useLiveData } from '../state/LiveDataContext';
import type { ValveCommand } from '../types';
import { cx } from './ui';

/** Follows a command through pending -> sent -> confirmed / timed out, live. */
export function CommandResult({ result, onClose }: { result: { command?: ValveCommand; error?: string } | null; onClose: () => void }) {
  const { commands, valves } = useLiveData();
  if (!result) return null;

  const command = result.command ? (commands.find((c) => c.id === result.command!.id) ?? result.command) : null;
  const valve = command && valves.find((v) => v.id === command.valveId);
  const verb = command?.action === 'close' ? 'Close' : 'Open';

  let tone = 'border-line bg-surface text-ink';
  let icon = <Loader2 size={18} className="animate-spin" aria-hidden />;
  let text: string;

  if (result.error) {
    tone = 'border-critical/40 bg-critical-soft text-critical-ink';
    icon = <Ban size={18} aria-hidden />;
    text = result.error;
  } else if (command?.status === 'rejected') {
    tone = 'border-critical/40 bg-critical-soft text-critical-ink';
    icon = <Ban size={18} aria-hidden />;
    text = `${verb} ${valve?.code} was refused. ${command.rejectReason}.`;
  } else if (command?.status === 'confirmed') {
    tone = 'border-good/40 bg-good-soft text-good-ink';
    icon = <CheckCircle2 size={18} aria-hidden />;
    text = `${valve?.code} is now ${command.action === 'close' ? 'closed' : 'open'}. The node confirmed the command.`;
  } else if (command?.status === 'timed_out') {
    tone = 'border-serious/50 bg-serious-soft text-serious-ink';
    icon = <Clock size={18} aria-hidden />;
    text = `${valve?.code} did not confirm in time. Check the node and the valve wiring.`;
  } else {
    text = `${verb} ${valve?.code}: ${command?.status === 'sent' ? 'sent to the node, waiting for confirmation…' : 'sending…'}`;
  }

  return (
    <div className={cx('mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', tone)} role="status">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="flex-1">{text}</span>
      <button onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
        <X size={16} />
      </button>
    </div>
  );
}
