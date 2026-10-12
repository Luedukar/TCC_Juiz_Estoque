import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { describeError } from '../lib/errors';

export default function Login() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(describeError(err).message);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <form onSubmit={onSubmit} className="w-full max-w-sm border-2 border-ink bg-paper p-6" aria-labelledby="login-title">
        <h1 id="login-title" className="text-2xl font-semibold tracking-tight">
          Controle de Estoque
        </h1>
        <p className="mt-1 text-ink-soft">Entre com seu e-mail e senha.</p>

        <label htmlFor="email" className="mt-6 block text-sm font-semibold">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 h-12 w-full rounded-[3px] border-2 border-ink bg-paper px-3"
        />

        <label htmlFor="password" className="mt-4 block text-sm font-semibold">
          Senha
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 h-12 w-full rounded-[3px] border-2 border-ink bg-paper px-3"
        />

        {error && (
          <p role="alert" className="mt-4 border-l-4 border-tag-red bg-concrete px-3 py-2 text-sm font-medium">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 h-12 w-full rounded-[3px] bg-pallet font-semibold text-white hover:bg-pallet-dark disabled:opacity-60"
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
