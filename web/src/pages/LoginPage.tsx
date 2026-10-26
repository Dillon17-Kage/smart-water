import { Droplets } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '../components/ui';
import { dataSource } from '../data';
import { useAuth } from '../state/AuthContext';

const demoAccounts = [
  ['admin', 'Administrator'],
  ['operator', 'Operator'],
  ['tech', 'Technician'],
  ['engineer', 'Engineer'],
] as const;

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-12 place-items-center rounded-xl bg-accent text-accent-ink">
            <Droplets size={26} aria-hidden />
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">Smart Water</h1>
          <p className="mt-1 text-sm text-ink-2">Water network monitoring and leak detection</p>
        </div>

        <form onSubmit={submit} className="rounded-xl border border-line bg-surface p-5" noValidate>
          <label className="block text-sm font-medium" htmlFor="username">
            Username
          </label>
          <input
            id="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          />
          <label className="mt-4 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          />

          {error && (
            <p className="mt-4 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical-ink" role="alert">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" className="mt-5 w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {dataSource.kind === 'mock' && (
          <div className="mt-4 rounded-xl border border-dashed border-line-strong p-4 text-xs text-ink-2">
            <p className="font-medium text-ink">Simulator mode: demo accounts</p>
            <p className="mt-1">
              Password for all: <code className="rounded bg-surface-2 px-1">smartwater</code>
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {demoAccounts.map(([name, role]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    setUsername(name);
                    setPassword('smartwater');
                    setError(null);
                  }}
                  className="rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="font-medium text-ink">{name}</span>
                  <span className="block text-ink-3">{role}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
