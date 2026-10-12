import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, CircleCheck, LogOut, Package, RefreshCw, WifiOff } from 'lucide-react';
import { apiRequest, ApiError, Balance } from '../lib/api';

type Props = { token: string; onLogout: () => void };
type State = 'loading' | 'ready' | 'error';

export default function StockDashboard({ token, onLogout }: Props) {
  const [items, setItems] = useState<Balance[]>([]);
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadBalances = useCallback(async () => {
    setState('loading');
    setMessage('');
    try {
      const response = await apiRequest<{ data: Balance[] }>('/movements/balances', {}, token);
      setItems(response.data);
      setLastUpdated(new Date());
      setState('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onLogout(); return; }
      setMessage(error instanceof ApiError ? error.message : 'Falha ao carregar o estoque.');
      setState('error');
    }
  }, [token, onLogout]);

  useEffect(() => { void loadBalances(); }, [loadBalances]);

  const critical = useMemo(() => items.filter(item => item.is_below_safety_stock), [items]);
  const totalUnits = useMemo(() => items.reduce((sum, item) => sum + Number(item.quantity_on_hand), 0), [items]);

  return <div className="min-h-screen bg-canvas text-ink">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-white"><Boxes size={21} /></div><div><p className="text-sm font-semibold tracking-wide text-brand">ESTOQUE</p><p className="text-xs text-muted">Painel de controle</p></div></div>
        <button onClick={onLogout} className="icon-button" aria-label="Sair"><LogOut size={18} /><span className="hidden sm:inline">Sair</span></button>
      </div>
    </header>

    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-1 text-sm font-medium text-brand">VISÃO GERAL</p><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Seu estoque, em um olhar</h1><p className="mt-2 text-sm text-muted">Acompanhe os níveis atuais e priorize os itens que precisam de reposição.</p></div>
        <button onClick={() => void loadBalances()} disabled={state === 'loading'} className="secondary-button"><RefreshCw size={16} className={state === 'loading' ? 'animate-spin' : ''} />Atualizar</button>
      </div>

      {state === 'error' && <div role="alert" className="mb-6 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><WifiOff className="mt-0.5 shrink-0 text-amber-700" size={20} /><div><p className="font-medium text-amber-900">Não foi possível atualizar o estoque</p><p className="mt-1 text-sm text-amber-800">{message} {items.length > 0 && 'Os últimos dados carregados continuam visíveis.'}</p></div></div><button onClick={() => void loadBalances()} className="self-start text-sm font-semibold text-amber-900 underline underline-offset-4 sm:self-auto">Tentar novamente</button></div>}

      <section aria-label="Indicadores do estoque" className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric icon={<Package size={19} />} label="Produtos cadastrados" value={state === 'loading' && !items.length ? '—' : items.length.toLocaleString('pt-BR')} detail="Itens ativos no catálogo" tone="green" />
        <Metric icon={<Boxes size={19} />} label="Unidades em estoque" value={state === 'loading' && !items.length ? '—' : totalUnits.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} detail="Saldo somado dos produtos" tone="blue" />
        <Metric icon={critical.length ? <AlertTriangle size={19} /> : <CircleCheck size={19} />} label="Abaixo do mínimo" value={state === 'loading' && !items.length ? '—' : critical.length.toLocaleString('pt-BR')} detail={critical.length ? 'Precisam de atenção' : 'Tudo dentro do nível de segurança'} tone={critical.length ? 'amber' : 'green'} />
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 sm:px-6"><div><h2 className="font-semibold">Alertas de estoque baixo</h2><p className="mt-1 text-sm text-muted">Produtos no nível de segurança ou abaixo dele</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${critical.length ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>{critical.length} {critical.length === 1 ? 'item' : 'itens'}</span></div>
        {state === 'loading' && !items.length ? <div className="p-10 text-center text-sm text-muted"><RefreshCw className="mx-auto mb-3 animate-spin" size={20} />Carregando saldos…</div> : critical.length === 0 ? <div className="p-10 text-center"><CircleCheck className="mx-auto mb-3 text-emerald-600" size={28} /><p className="font-medium">Nenhum item crítico</p><p className="mt-1 text-sm text-muted">Os produtos estão acima do estoque de segurança.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-muted"><tr><th className="px-6 py-3 font-medium">Produto</th><th className="px-6 py-3 font-medium">SKU / Código de barras</th><th className="px-6 py-3 text-right font-medium">Saldo atual</th><th className="px-6 py-3 text-right font-medium">Estoque mínimo</th><th className="px-6 py-3 text-right font-medium">Situação</th></tr></thead><tbody className="divide-y divide-slate-100">{critical.map(item => <tr key={item.product_id} className="hover:bg-slate-50"><td className="px-6 py-4 font-medium">{item.name}</td><td className="px-6 py-4 text-muted">{item.sku}<span className="block text-xs">{item.barcode || 'Sem código de barras'}</span></td><td className="px-6 py-4 text-right font-semibold tabular-nums">{Number(item.quantity_on_hand).toLocaleString('pt-BR')}</td><td className="px-6 py-4 text-right tabular-nums">{Number(item.safety_stock).toLocaleString('pt-BR')}</td><td className="px-6 py-4 text-right"><span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800"><AlertTriangle size={13} />Repor</span></td></tr>)}</tbody></table></div>}
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-muted sm:px-6">{lastUpdated ? `Atualizado às ${lastUpdated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Os saldos são atualizados ao consultar o servidor.'}</div>
      </section>
    </main>
  </div>;
}

function Metric({ icon, label, value, detail, tone }: { icon: React.ReactNode; label: string; value: string; detail: string; tone: 'green' | 'blue' | 'amber' }) {
  const tones = { green: 'bg-emerald-50 text-emerald-700', blue: 'bg-sky-50 text-sky-700', amber: 'bg-amber-50 text-amber-700' };
  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-panel"><div className="flex items-start justify-between"><div><p className="text-sm text-muted">{label}</p><p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p></div><span className={`grid h-10 w-10 place-items-center rounded-xl ${tones[tone]}`}>{icon}</span></div><p className="mt-3 text-xs text-muted">{detail}</p></article>;
}
