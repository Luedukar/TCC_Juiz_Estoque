import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorState, Skeleton } from '../components/ErrorState';
import { StatusBadge, STATUS_BORDER } from '../components/StatusBadge';
import { StockGauge } from '../components/StockGauge';
import { api } from '../lib/api';
import { fmtDateTime, fmtQty, fmtTime, plural, REASON_LABEL } from '../lib/format';
import { useConnection } from '../lib/hooks';

export default function Dashboard() {
  const conn = useConnection();
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: ({ signal }) => api.alerts(signal),
    refetchInterval: 30_000,
  });
  const recent = useQuery({
    queryKey: ['movements', 'recent'],
    queryFn: ({ signal }) => api.movements({ limit: 8 }, signal),
    refetchInterval: 30_000,
  });

  const summary = alerts.data?.summary;
  const items = alerts.data?.data ?? [];
  // dados na tela, mas a última atualização falhou: mostramos a hora do último dado bom
  const stale = alerts.isError && !!alerts.data;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <section aria-labelledby="critico">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 id="critico" className="text-2xl font-semibold tracking-tight">
              Estoque crítico
            </h1>
            <p className="mt-0.5 text-sm text-ink-soft" aria-live="polite">
              {alerts.dataUpdatedAt
                ? stale || conn.status === 'offline'
                  ? `Dados de ${fmtTime(alerts.dataUpdatedAt)}. Atualizam quando o servidor responder.`
                  : `Atualizado às ${fmtTime(alerts.dataUpdatedAt)}`
                : 'Itens no estoque de segurança ou abaixo dele'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void alerts.refetch();
              void recent.refetch();
            }}
            disabled={alerts.isFetching}
            className="h-10 rounded-[3px] border border-ink/50 px-4 text-sm font-semibold hover:bg-paper disabled:opacity-60"
          >
            {alerts.isFetching ? 'Atualizando…' : 'Atualizar'}
          </button>
        </header>

        {alerts.isPending && <Skeleton rows={5} />}
        {alerts.isError && !alerts.data && <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />}

        {summary && (
          <>
            <div className="flex divide-x divide-line border border-line bg-paper">
              <div className="flex-1 px-5 py-4">
                <p className={`text-4xl font-semibold tabular-nums ${summary.zerado ? 'text-tag-red' : 'text-ink-soft'}`}>
                  {summary.zerado}
                </p>
                <p className="text-sm text-ink-soft">{plural(summary.zerado, 'item zerado', 'itens zerados')}</p>
              </div>
              <div className="flex-1 px-5 py-4">
                <p className={`text-4xl font-semibold tabular-nums ${summary.baixo ? 'text-caution' : 'text-ink-soft'}`}>
                  {summary.baixo}
                </p>
                <p className="text-sm text-ink-soft">
                  {plural(summary.baixo, 'item abaixo do mínimo', 'itens abaixo do mínimo')}
                </p>
              </div>
            </div>

            {items.length === 0 ? (
              <p className="mt-3 border border-line bg-paper px-5 py-6 font-medium">
                Nenhum item no estoque de segurança ou abaixo dele.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line border border-line bg-paper">
                {items.map((it) => (
                  <li key={it.id} className={`border-l-4 px-4 py-4 ${STATUS_BORDER[it.status]}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{it.name}</p>
                        <p className="font-mono text-xs text-ink-soft">{it.sku}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="font-semibold tabular-nums">
                          {fmtQty(it.currentStock)} <span className="font-normal text-ink-soft">de {fmtQty(it.safetyStock)}</span>
                        </p>
                        <StatusBadge status={it.status} />
                      </div>
                    </div>
                    <div className="mt-3">
                      <StockGauge current={it.currentStock} safety={it.safetyStock} status={it.status} />
                    </div>
                    <p className="mt-2 text-sm text-ink-soft">
                      Faltam {fmtQty(it.shortfall)} {it.unit.toLowerCase()} para o mínimo.
                      {it.preferredSupplier ? ` Fornecedor preferido: ${it.preferredSupplier}.` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <aside aria-labelledby="recentes">
        <h2 id="recentes" className="mb-4 text-lg font-semibold">
          Últimas movimentações
        </h2>
        {recent.isPending && <Skeleton rows={4} />}
        {recent.isError && !recent.data && <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />}
        {recent.data &&
          (recent.data.data.length === 0 ? (
            <p className="border border-line bg-paper px-4 py-5">
              Nenhuma movimentação ainda.{' '}
              <Link to="/movimentacao" className="font-semibold text-pallet underline">
                Registrar a primeira
              </Link>
            </p>
          ) : (
            <ul className="divide-y divide-line border border-line bg-paper">
              {recent.data.data.map((m) => (
                <li key={m.id} className="px-4 py-3 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium">{m.productName}</span>
                    <span className={`shrink-0 font-semibold tabular-nums ${m.type === 'ENTRADA' ? 'text-shelf-green' : 'text-ink'}`}>
                      {m.type === 'ENTRADA' ? '+' : '−'}
                      {fmtQty(m.quantity)}
                    </span>
                  </div>
                  <p className="text-ink-soft">
                    {m.type === 'ENTRADA' ? 'Entrada' : 'Saída'} por {REASON_LABEL[m.reason]?.toLowerCase() ?? m.reason}, {m.userName},{' '}
                    {fmtDateTime(m.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          ))}
      </aside>
    </div>
  );
}
