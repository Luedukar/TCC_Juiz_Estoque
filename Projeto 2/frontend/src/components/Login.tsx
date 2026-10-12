import { FormEvent, useState } from 'react';
import { Boxes, LockKeyhole } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api';

type Props = { onLogin: (token: string) => void };

export default function Login({ onLogin }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await apiRequest<{ token: string }>('/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      onLogin(response.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally { setLoading(false); }
  }

  return <main className="grid min-h-screen place-items-center bg-canvas px-4">
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-panel">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand text-white"><Boxes size={23} /></div>
        <div><p className="text-sm font-semibold text-brand">ESTOQUE</p><h1 className="text-xl font-semibold">Acesse sua conta</h1></div>
      </div>
      <p className="mb-6 text-sm text-muted">Entre para acompanhar os níveis e movimentações da loja.</p>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium">E-mail<input required type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} className="form-input mt-1.5" /></label>
        <label className="block text-sm font-medium">Senha<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="form-input mt-1.5" /></label>
        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"><LockKeyhole className="mr-1 inline" size={15} />{error}</p>}
        <button disabled={loading} className="primary-button w-full">{loading ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </section>
  </main>;
}
