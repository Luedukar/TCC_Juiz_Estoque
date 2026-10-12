import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { getLowStock, login } from './api';
import type { LowStockProduct, LoginResponse } from './types';

function Icon({ name, className = 'h-5 w-5' }: { name: string; className?: string }) {
  const common = {
    className,
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
    viewBox: '0 0 24 24',
    'aria-hidden': true as const
  };

  if (name === 'box') return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 8 9 5 9-5M3 8v9l9 5 9-5V8M12 13v9" /></svg>;
  if (name === 'alert') return <svg {...common}><path d="M10.3 4.3 2.8 17.2a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></svg>;
  if (name === 'arrow') return <svg {...common}><path d="M7 17 17 7M7 7h10v10" /></svg>;
  if (name === 'refresh') return <svg {...common}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" /></svg>;
  if (name === 'logout') return <svg {...common}><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
  return <svg {...common}><path d="M4 20V10m5 10V4m5 16v-7m5 7V7" /></svg>;
}

function formatQuantity(quantity: number | string) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(quantity));
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function LoginScreen({ onLogin }: { onLogin: (result: LoginResponse) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await login(email, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[1fr_0.9fr]">
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-md">
          <Brand />
          <div className="mt-14">
            <p className="text-sm font-semibold text-brand-600">BEM-VINDO DE VOLTA</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink">Acesse seu estoque</h1>
            <p className="mt-2 text-sm leading-6 text-muted">Entre com suas credenciais para acompanhar a operação da loja.</p>
          </div>
          <form className="mt-9 space-y-5" onSubmit={submit}>
            <label className="field-label">
              E-mail
              <input
                autoComplete="username"
                className="field-input"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="voce@sualoja.com.br"
                required
                type="email"
                value={email}
              />
            </label>
            <label className="field-label">
              Senha
              <input
                autoComplete="current-password"
                className="field-input"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Sua senha"
                required
                type="password"
                value={password}
              />
            </label>
            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}
            <button className="primary-button w-full" disabled={busy} type="submit">
              {busy ? <><span className="spinner" />Conectando...</> : 'Entrar no painel'}
            </button>
          </form>
          <p className="mt-8 text-center text-xs text-muted">Acesso protegido para sua equipe de estoque.</p>
        </div>
      </section>
      <aside className="relative hidden overflow-hidden bg-[#113b2b] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-32 -top-32 h-[540px] w-[540px] rounded-full border border-white/10" />
        <div className="absolute -right-12 -top-12 h-[300px] w-[300px] rounded-full border border-white/10" />
        <div className="relative mt-10 max-w-lg">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10"><Icon name="box" className="h-7 w-7" /></div>
          <h2 className="mt-8 text-4xl font-semibold leading-tight tracking-tight">Estoque em dia.<br />Loja em movimento.</h2>
          <p className="mt-5 max-w-md leading-7 text-white/65">Tenha visibilidade do que precisa de atenção e mantenha cada produto no lugar certo.</p>
        </div>
        <div className="relative flex items-center gap-3 text-sm text-white/60"><span className="h-2 w-2 rounded-full bg-emerald-300" />Controle simples, operação mais leve.</div>
      </aside>
    </main>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white"><Icon name="box" /></span>
      <span className="text-lg font-semibold tracking-tight text-ink">stockroom<span className="text-brand-600">.</span></span>
    </div>
  );
}

function Dashboard({ user, token, onLogout }: {
  user: LoginResponse['user'];
  token: string;
  onLogout: () => void;
}) {
  const [products, setProducts] = useState<LowStockProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [query, setQuery] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError('');
    try {
      setProducts(await getLowStock(token, signal));
      setLastUpdated(new Date());
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setLoadError(cause instanceof Error ? cause.message : 'Não foi possível carregar os alertas.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    if (!normalized) return products;
    return products.filter((product) =>
      `${product.name} ${product.sku} ${product.barcode ?? ''}`.toLocaleLowerCase('pt-BR').includes(normalized)
    );
  }, [products, query]);

  const outOfStock = products.filter((product) => Number(product.quantity) === 0).length;
  const needsReplenishment = products.filter((product) =>
    Number(product.quantity) > 0 && Number(product.quantity) <= Number(product.safety_stock)
  ).length;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[250px] flex-col border-r border-line bg-white px-5 py-6 lg:flex">
        <Brand />
        <div className="mt-12">
          <p className="px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-muted">Visão geral</p>
          <a className="mt-3 flex items-center gap-3 rounded-xl bg-brand-50 px-3 py-3 text-sm font-semibold text-brand-700" href="#dashboard">
            <Icon name="chart" />Painel de estoque
          </a>
        </div>
        <div className="mt-auto rounded-2xl bg-canvas p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{initials(user.name)}</span>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{user.name}</p><p className="mt-0.5 text-xs text-muted">{user.role === 'manager' ? 'Gerente' : 'Estoquista'}</p></div>
          </div>
          <button className="mt-4 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-muted transition hover:bg-white hover:text-ink" onClick={onLogout} type="button">
            <Icon name="logout" className="h-4 w-4" />Sair da conta
          </button>
        </div>
      </aside>

      <div className="lg:pl-[250px]">
        <header className="sticky top-0 z-10 flex h-[76px] items-center justify-between border-b border-line bg-white/90 px-5 backdrop-blur sm:px-8">
          <div className="flex items-center gap-3 lg:hidden"><Brand /></div>
          <div className="hidden text-sm text-muted lg:block">Operação <span className="mx-2 text-line">/</span><span className="font-medium text-ink">Painel de estoque</span></div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted sm:inline">{lastUpdated ? `Atualizado às ${lastUpdated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Sincronizando dados'}</span>
            <button aria-label="Atualizar alertas" className="icon-button" disabled={loading} onClick={() => void refresh()} type="button"><Icon name="refresh" className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></button>
            <button aria-label="Sair da conta" className="icon-button lg:hidden" onClick={onLogout} type="button"><Icon name="logout" className="h-4 w-4" /></button>
          </div>
        </header>

        <main className="mx-auto max-w-[1440px] px-5 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
                {new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date()).toLocaleUpperCase('pt-BR')}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-[34px]">Bom dia, {user.name.split(' ')[0]}</h1>
              <p className="mt-2 text-sm text-muted">Aqui está o resumo do que precisa da sua atenção.</p>
            </div>
            <div className="flex items-center gap-2 self-start rounded-full border border-line bg-white px-3 py-2 text-xs font-medium text-muted sm:self-auto">
              <span className={`h-2 w-2 rounded-full ${loadError ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              {loadError ? 'Conexão instável' : 'Estoque sincronizado'}
            </div>
          </div>

          {loadError && (
            <div className="mt-7 flex flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3"><Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><p className="text-sm font-semibold text-amber-900">Não foi possível atualizar o painel</p><p className="mt-1 text-sm text-amber-800">{loadError}</p></div></div>
              <button className="secondary-button shrink-0 border-amber-200 bg-white text-amber-900 hover:bg-amber-100" onClick={() => void refresh()} type="button">Tentar novamente</button>
            </div>
          )}

          <section aria-label="Resumo do estoque" className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <MetricCard label="Produtos em alerta" value={loading && products.length === 0 ? '—' : String(products.length)} detail="Abaixo ou no estoque de segurança" icon="alert" tone="amber" />
            <MetricCard label="Sem estoque" value={loading && products.length === 0 ? '—' : String(outOfStock)} detail="Itens que precisam de reposição urgente" icon="box" tone="red" />
            <MetricCard label="Repor em breve" value={loading && products.length === 0 ? '—' : String(needsReplenishment)} detail="Ainda disponíveis, mas no limite" icon="chart" tone="green" />
          </section>

          <section className="mt-8 overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
            <div className="flex flex-col justify-between gap-4 border-b border-line px-5 py-5 sm:flex-row sm:items-center sm:px-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Icon name="alert" /></span>
                <div><h2 className="text-base font-semibold">Atenção ao estoque</h2><p className="mt-1 text-xs text-muted">{products.length} {products.length === 1 ? 'produto precisa' : 'produtos precisam'} de reposição</p></div>
              </div>
              <label className="relative block sm:w-[270px]">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm outline-none transition placeholder:text-muted/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar produto ou SKU" value={query} />
              </label>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left">
                <thead className="bg-[#fafbfa] text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
                  <tr><th className="px-6 py-3.5">Produto</th><th className="px-4 py-3.5">SKU</th><th className="px-4 py-3.5">Disponível</th><th className="px-4 py-3.5">Estoque mínimo</th><th className="px-6 py-3.5 text-right">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {loading && products.length === 0 ? (
                    Array.from({ length: 4 }, (_, index) => <tr key={index}><td className="px-6 py-5" colSpan={5}><div className="h-5 animate-pulse rounded bg-canvas" /></td></tr>)
                  ) : filteredProducts.length > 0 ? filteredProducts.map((product) => {
                    const empty = Number(product.quantity) === 0;
                    return (
                      <tr className="transition hover:bg-[#fcfdfc]" key={product.id}>
                        <td className="px-6 py-4"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-canvas text-muted"><Icon name="box" className="h-4 w-4" /></span><div><p className="max-w-[260px] truncate text-sm font-semibold text-ink">{product.name}</p><p className="mt-1 text-xs text-muted">{product.barcode || 'Sem código de barras'}</p></div></div></td>
                        <td className="px-4 py-4 font-mono text-xs text-muted">{product.sku}</td>
                        <td className={`px-4 py-4 text-sm font-semibold ${empty ? 'text-red-600' : 'text-ink'}`}>{formatQuantity(product.quantity)}</td>
                        <td className="px-4 py-4 text-sm text-muted">{formatQuantity(product.safety_stock)}</td>
                        <td className="px-6 py-4 text-right"><span className={empty ? 'status-pill status-red' : 'status-pill status-amber'}><span className="h-1.5 w-1.5 rounded-full bg-current" />{empty ? 'Sem estoque' : 'Estoque baixo'}</span></td>
                      </tr>
                    );
                  }) : (
                    <tr><td className="px-6 py-14 text-center" colSpan={5}><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Icon name={query ? 'search' : 'box'} /></div><p className="mt-4 text-sm font-semibold">{query ? 'Nenhum produto encontrado' : 'Tudo em ordem por aqui'}</p><p className="mt-1 text-sm text-muted">{query ? 'Tente buscar por outro nome, SKU ou código.' : 'Não há produtos abaixo do estoque de segurança.'}</p></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-6 py-4 text-xs text-muted">
              <span>Exibindo {filteredProducts.length} de {products.length} produtos</span>
              <span className="hidden sm:inline">Os saldos são atualizados após cada movimentação.</span>
            </div>
          </section>
          <footer className="mt-8 flex flex-col justify-between gap-2 text-xs text-muted sm:flex-row"><span>Stockroom · Controle de estoque</span><span>Dados protegidos e atualizados em tempo real.</span></footer>
        </main>
      </div>
    </div>
  );
}

function MetricCard({ label, value, detail, icon, tone }: {
  label: string;
  value: string;
  detail: string;
  icon: string;
  tone: 'amber' | 'red' | 'green';
}) {
  const toneClass = {
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-600',
    green: 'bg-brand-50 text-brand-600'
  }[tone];
  return (
    <article className="rounded-2xl border border-line bg-white p-5 shadow-soft sm:p-6">
      <div className="flex items-start justify-between">
        <div><p className="text-sm font-medium text-muted">{label}</p><p className="mt-4 text-3xl font-semibold tracking-tight text-ink">{value}</p></div>
        <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${toneClass}`}><Icon name={icon} /></span>
      </div>
      <p className="mt-4 border-t border-line pt-4 text-xs text-muted">{detail}</p>
    </article>
  );
}

export default function App() {
  const [session, setSession] = useState<LoginResponse | null>(null);

  if (!session) return <LoginScreen onLogin={setSession} />;
  return <Dashboard user={session.user} token={session.accessToken} onLogout={() => setSession(null)} />;
}
