import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useHotkeys } from '../lib/hooks';
import { useOutboxSync } from '../lib/useOutboxSync';
import { ConnectionBanner } from './ConnectionBanner';

const NAV = [
  { to: '/', label: 'Painel', hint: 'Alt 1', end: true },
  { to: '/movimentacao', label: 'Movimentação', hint: 'Alt 2', end: false },
  { to: '/saldos', label: 'Saldos', hint: 'Alt 3', end: false },
  { to: '/kardex', label: 'Kardex', hint: 'Alt 4', end: false },
];

function Mark() {
  // quatro barras: o código de barras como marca
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
      <rect x="1" y="2" width="3" height="18" fill="currentColor" />
      <rect x="6" y="2" width="1.5" height="18" fill="currentColor" />
      <rect x="10" y="2" width="4" height="18" fill="currentColor" />
      <rect x="16" y="2" width="1.5" height="18" fill="currentColor" />
      <rect x="19.5" y="2" width="1.5" height="18" fill="currentColor" />
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const syncNow = useOutboxSync();

  useHotkeys({
    'alt+1': () => navigate('/'),
    'alt+2': () => navigate('/movimentacao'),
    'alt+3': () => navigate('/saldos'),
    'alt+4': () => navigate('/kardex'),
  });

  const roleLabel = user?.role === 'GERENTE' ? 'Gerente' : 'Estoquista';

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_minmax(0,1fr)]">
      {/* Menu lateral (tela larga) */}
      <aside className="sticky top-0 hidden h-dvh flex-col bg-ink text-paper md:flex">
        <div className="flex items-center gap-2.5 px-5 py-6">
          <Mark />
          <span className="text-lg font-semibold tracking-tight">Estoque</span>
        </div>
        <nav aria-label="Principal" className="flex-1 px-2">
          <ul className="space-y-0.5">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    `flex items-center justify-between rounded-[3px] px-3 py-2.5 text-[15px] ${
                      isActive ? 'bg-paper font-semibold text-ink' : 'text-concrete-deep hover:bg-white/10'
                    }`
                  }
                >
                  <span>{n.label}</span>
                  <span className="text-xs opacity-60">{n.hint}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-white/15 px-5 py-4 text-sm">
          <p className="truncate font-medium">{user?.name}</p>
          <p className="text-concrete-deep">{roleLabel}</p>
          <button
            type="button"
            onClick={logout}
            className="mt-3 h-9 rounded-[3px] border border-white/40 px-3 text-sm font-semibold hover:bg-white/10"
          >
            Sair
          </button>
        </div>
      </aside>

      <div className="min-w-0 pb-20 md:pb-0">
        {/* Barra superior (celular) */}
        <header className="flex items-center justify-between bg-ink px-4 py-3 text-paper md:hidden">
          <span className="flex items-center gap-2 font-semibold">
            <Mark />
            Estoque
          </span>
          <span className="flex items-center gap-3 text-sm">
            <span className="text-concrete-deep">{roleLabel}</span>
            <button type="button" onClick={logout} className="h-9 rounded-[3px] border border-white/40 px-3 font-semibold">
              Sair
            </button>
          </span>
        </header>

        <ConnectionBanner syncNow={syncNow} />

        <main className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>

      {/* Navegação inferior (celular) */}
      <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-ink bg-paper md:hidden">
        <ul className="grid grid-cols-4">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `block py-3.5 text-center text-[13px] ${isActive ? 'bg-ink font-semibold text-paper' : 'text-ink'}`
                }
              >
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
