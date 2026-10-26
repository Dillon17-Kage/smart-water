// Times are stored in UTC and shown in the browser's local time zone (SAST on the rig).

export function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString([], {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function formatAgo(isoString: string | null | undefined, now = Date.now()): string {
  if (!isoString) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(isoString)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

export function formatDuration(fromIso: string, toIso?: string | null): string {
  const seconds = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function fmt(value: number | null | undefined, places = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const text = value.toFixed(places);
  return Number(text) === 0 ? (0).toFixed(places) : text; // no "-0.00"
}

export function chartTime(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
