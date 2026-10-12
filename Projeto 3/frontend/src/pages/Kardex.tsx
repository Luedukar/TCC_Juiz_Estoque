import { useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorState, Skeleton } from '../components/ErrorState';
import { ProductFinder } from '../components/ProductFinder';
import type { FinderHandle } from '../components/ProductFinder';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { describeError } from '../lib/errors';
import { fmtDateTime, fmtMoney, fmtQty, REASON_LABEL } from '../lib/format';
import { useHotkeys } from '../lib/hooks';
import type { Balance, Movement } from '../lib/types';

const PAGE = 50;

export default function Kardex() {
  const { isManager } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const finderRef = useRef<FinderHandle>(null);
  const [product, setProduct] = useState<Balance | null>(null);
  const [target, setTarget] = useState<Movement | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useHotkeys({ '/': () => finderRef.current?.focus() });

  const q = useInfiniteQuery({
    queryKey: ['movements', 'kardex', product?.id],
    enabled: !!product,
    queryFn: ({ pageParam, signal }) => api.movements({ productId: product!.id, limit: PAGE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.data.length === last.limit ? last.offset + last.limit : undefined),
  });

  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  async function reverse() {
    if (!target) return;
    setBusy(true);
    setDialogError(null);
    try {
      // a chave é gerada uma vez por confirmação: reenviar após um timeout não estorna duas vezes
      await api.reverseMovement(target.id, notes.trim() || undefined, crypto.randomUUID());
      toast.push({ tone: 'ok', text: `Estorno registrado: movimentação ${target.id} de ${target.productName}.` });
      setTarget(null);
      setNotes('');
      void qc.invalidateQueries();
    } catch (e) {
      const d = describeError(e);
      setDialogError(d.network ? `${d.message} O estorno não foi enviado. Tente de novo quando a conexão voltar.` : d.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Kardex</h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        Extrato de movimentações de um produto, da mais recente para a mais antiga. Nada é apagado: erros se corrigem com estorno.
      </p>

      <div className="mt-5 max-w-xl">
        <ProductFinder ref={finderRef} onSelect={(p) => setProduct(p)} label="Escolha o produto" />
      </div>

      {!product && <p className="mt-8 text-ink-soft">Escolha um produto para ver o extrato.</p>}

      {product && (
        <section className="mt-6" aria-labelledby="kx-title">
          <h2 id="kx-title" className="text-lg font-semibold">
            {product.name} <span className="font-mono text-sm font-normal text-ink-soft">{product.sku}</span>
          </h2>

          <div className="mt-3">
            {q.isPending && <Skeleton rows={5} />}
            {q.isError && rows.length === 0 && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
            {q.data && rows.length === 0 && (
              <p className="border border-line bg-paper px-5 py-6 font-medium">Este produto ainda não tem movimentações.</p>
            )}

            {rows.length > 0 && (
              <div className="overflow-x-auto border border-line bg-paper">
                <table className="w-full min-w-[48rem] text-left text-sm">
                  <caption className="sr-only">Movimentações de {product.name}</caption>
                  <thead className="border-b-2 border-ink">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">Data e hora</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Movimentação</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">Quantidade</th>
                      <th scope="col" className="px-4 py-3 text-right font-semibold">Saldo</th>
                      <th scope="col" className="px-4 py-3 font-semibold">Registrada por</th>
                      {isManager && <th scope="col" className="px-4 py-3 text-right font-semibold">Custo unit.</th>}
                      {isManager && <th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((m) => {
                      const reversed = m.reversedById !== null;
                      const isReversal = m.reversalOfId !== null;
                      return (
                        <tr key={m.id} className={reversed ? 'text-ink-soft' : ''}>
                          <td className="whitespace-nowrap px-4 py-3 tabular-nums">{fmtDateTime(m.createdAt)}</td>
                          <td className="px-4 py-3">
                            <span className="font-medium">
                              {m.type === 'ENTRADA' ? 'Entrada' : 'Saída'}: {REASON_LABEL[m.reason] ?? m.reason}
                            </span>
                            {m.documentRef && <span className="block text-xs">Documento {m.documentRef}</span>}
                            {isReversal && <span className="block text-xs">Estorna a movimentação {m.reversalOfId}</span>}
                            {reversed && <span className="block text-xs font-medium">Estornada pela movimentação {m.reversedById}</span>}
                            {m.notes && <span className="block text-xs">{m.notes}</span>}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">
                            {m.type === 'ENTRADA' ? '+' : '−'}
                            {fmtQty(m.quantity)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {fmtQty(m.balanceBefore)} → {fmtQty(m.balanceAfter)}
                          </td>
                          <td className="px-4 py-3">{m.userName}</td>
                          {isManager && (
                            <td className="px-4 py-3 text-right tabular-nums">
                              {m.unitCost != null ? fmtMoney(m.unitCost) : '—'}
                            </td>
                          )}
                          {isManager && (
                            <td className="px-4 py-3 text-right">
                              {!reversed && !isReversal && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTarget(m);
                                    setNotes('');
                                    setDialogError(null);
                                  }}
                                  className="h-9 rounded-[3px] border border-ink/50 px-3 font-semibold hover:bg-concrete"
                                >
                                  Estornar
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
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
                {q.isFetchingNextPage ? 'Carregando…' : 'Carregar movimentações mais antigas'}
              </button>
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!target}
        title="Estornar movimentação"
        confirmLabel="Estornar"
        busy={busy}
        error={dialogError}
        onConfirm={() => void reverse()}
        onCancel={() => setTarget(null)}
      >
        {target && (
          <>
            <p>
              {target.type === 'ENTRADA' ? 'Entrada' : 'Saída'} de {fmtQty(target.quantity)} de <strong>{target.productName}</strong>.
              O estorno registra uma movimentação oposta; a original continua no histórico.
            </p>
            <label htmlFor="estorno-obs" className="mt-4 block font-semibold">
              Motivo do estorno (opcional)
            </label>
            <textarea
              id="estorno-obs"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1.5 w-full rounded-[3px] border-2 border-ink bg-paper p-2"
            />
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
