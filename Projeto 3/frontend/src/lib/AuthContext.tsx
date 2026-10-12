import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { NetworkError, refreshSession } from './http';
import { session } from './session';
import type { Role, User } from './types';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

interface AuthValue {
  status: Status;
  user: User | null;
  isManager: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  retryBoot: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const user = useSyncExternalStore(session.subscribe, session.getUser);
  const [status, setStatus] = useState<Status>('loading');

  // Ao abrir/recarregar: se há refresh token, recupera a sessão. Servidor fora do ar NÃO desloga.
  const boot = useCallback(async () => {
    if (!session.getRefreshToken()) {
      setStatus('anonymous');
      return;
    }
    try {
      setStatus((await refreshSession()) ? 'authenticated' : 'anonymous');
    } catch (e) {
      setStatus(e instanceof NetworkError ? 'unavailable' : 'anonymous');
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Enquanto o servidor está fora no carregamento inicial, tenta de novo sozinho.
  useEffect(() => {
    if (status !== 'unavailable') return;
    const id = setInterval(() => void boot(), 6_000);
    return () => clearInterval(id);
  }, [status, boot]);

  // Sessão rejeitada pelo servidor (refresh inválido/expirado/reutilizado).
  useEffect(
    () =>
      session.onExpired(() => {
        qc.clear();
        setStatus('anonymous');
      }),
    [qc],
  );

  const login = useCallback(async (email: string, password: string) => {
    const tokens = await api.login(email, password);
    session.set(tokens);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(() => {
    const refreshToken = session.getRefreshToken();
    session.clear();
    qc.clear();
    setStatus('anonymous');
    if (refreshToken) void api.logout(refreshToken).catch(() => undefined);
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      isManager: (user?.role satisfies Role | undefined) === 'GERENTE',
      login,
      logout,
      retryBoot: () => void boot(),
    }),
    [status, user, login, logout, boot],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
