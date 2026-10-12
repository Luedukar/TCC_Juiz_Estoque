import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ErrorState, Skeleton } from '../components/ErrorState';
import { StatusBadge } from '../components/StatusBadge';
import { StockGauge } from '../components/StockGauge';
import { api } from '../lib/api';
import { fmtQty, STATUS_LABEL } from '../lib/format';
import { useHotkeys } from '../lib/hooks';
import type { StockStatus } from '../lib/types';

const PAGE = 50;
const FILTERS: (StockStatus | '')[] = ['', 'ZERADO', 'BAIXO', 'OK'];

export default function Balances() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<StockStatus | ''>('');

  useHotkeys({ '/': () => searchRef.current?.focus() });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);

  const q = useInfiniteQuery({
    queryKey: ['balances', debounced, status],
    queryFn: ({ pageParam, signal }) =>
      api.balances({ q: debounced || undefined, status: status || undefined, limit: PAGE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.data.length === last.limit ? last.offset + last.limit : undefined),
    placeholderData: (prev) => prev,
  });

  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Saldos</h1>
      <p className="mt-0.5 text-sm text-ink-soft">Posição atual de cada produto. Tecle / para buscar.</p>

      <div className="mt-5 flex flex-wrap items-end gap-4">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="busca" className="block text-sm font-semibold">
            Buscar por nome, SKU ou código de barras
          </label>
          <input
            id="busca"
            ref={searchRef}
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            autoComplete="off"
            className="mt-1.5 h-12 w-full rounded-[3px] border-2 border-ink bg-paper px-3"
          />
        </div>
        <fieldset>
          <legend className="text-sm font-semibold">Situação</legend>
          <div className="mt-1.5 flex">
            {FILTERS.map((f) => (
              <label key={f || 'todos'} className="relative">
                <input
                  type="radio"
                  name="situacao"
                  value={f}
                  checked={status === f}
                  onChange={() => setStatus(f)}
                  className="peer sr-only"
                />
                <span className="flex h-12 items-center border-2 border-ink px-3.5 text-sm font-medium peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pallet [&:not(:peer-checked)]:bg-paper not-first:-ml-0.5">
                  {f === '' ? 'Todos' : STATUS_LABEL[f]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="mt-5">
        {q.isPending && <Skeleton rows={6} />}
        {q.isError && rows.length === 0 && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

        {q.data && rows.length === 0 && (
          <p className="border border-line bg-paper px-5 py-6 font-medium">
            Nenhum produto encontrado{debounced ? ` para “${debounced}”` : ''}.
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto border border-line bg-paper">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">Saldo atual por produto</caption>
              <thead className="border-b-2 border-ink">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Produto</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Código de barras</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Saldo</th>
                  <th scope="col" className="w-40 px-4 py-3 font-semibold">Nível</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3">
                      <span className="block font-medium">{p.name}</span>
                      <span className="font-mono text-xs text-ink-soft">{p.sku}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{p.barcode ?? '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className="font-semibold">{fmtQty(p.currentStock)}</span>{' '}
                      <span className="text-ink-soft">/ {fmtQty(p.safetyStock)} {p.unit.toLowerCase()}</span>
                    </td>
                    <td className="px-4 py-3">
                      <StockGauge current={p.currentStock} safety={p.safetyStock} status={p.status} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {q.hasNextPage && (
          <button
            type="button"
            onClick={() => void q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="mt-4 h-11 rounded-[3px] border-2 border-ink px-5 font-semibold hover:bg-paper disabled:opacity-60"
          >
            {q.isFetchingNextPage ? 'Carregando…' : 'Carregar mais produtos'}
          </button>
        )}
        {q.isFetchNextPageError && <div className="mt-3"><ErrorState error={q.error} onRetry={() => void q.fetchNextPage()} /></div>}
      </div>
    </div>
  );
}
