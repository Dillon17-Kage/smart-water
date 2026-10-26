import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { can, type Permission } from '../auth/permissions';
import { dataSource } from '../data';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const STORAGE_KEY = 'smartwater.session';

function restoreSession(): User | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { user, token } = JSON.parse(raw) as { user: User; token: string };
    dataSource.resume(token);
    return user;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(restoreSession);

  const login = useCallback(async (username: string, password: string) => {
    const session = await dataSource.login(username, password);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Private mode or storage blocked: the session just won't survive a reload.
    }
    setUser(session.user);
  }, []);

  const logout = useCallback(() => {
    dataSource.logout();
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, login, logout, can: (permission) => can(user?.role, permission) }),
    [user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
