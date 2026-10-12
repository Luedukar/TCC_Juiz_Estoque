import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ProductFinder } from '../components/ProductFinder';
import type { FinderHandle } from '../components/ProductFinder';
import { ShelfTag } from '../components/ShelfTag';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { describeError } from '../lib/errors';
import { fmtDateTime, fmtQty, parseDecimal, plural, REASON_LABEL, REASONS, statusOf, TYPE_LABEL } from '../lib/format';
import { useHotkeys, useOutbox } from '../lib/hooks';
import { NetworkError } from '../lib/http';
import { outbox } from '../lib/outbox';
import type { Balance, MovementType, NewMovement } from '../lib/types';

interface Shown {
  product: Balance;
  change?: { before: number; after: number };
  stale: boolean;
}

interface LogEntry {
  id: string;
  text: string;
  queued: boolean;
  at: number;
}

const TYPE_KEY = 'estoque.lastType';
const loadType = (): MovementType => {
  try {
    return localStorage.getItem(TYPE_KEY) === 'SAIDA' ? 'SAIDA' : 'ENTRADA';
  } catch {
    return 'ENTRADA';
  }
};

export default function Movement() {
  const { user, isManager } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const finderRef = useRef<FinderHandle>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const outboxItems = useOutbox();

  const [product, setProduct] = useState<Balance | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [type, setType] = useState<MovementType>(loadType);
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const reasons = REASONS[type];
  const effectiveReason = reasons.includes(reason) ? reason : reasons[0];
  const mine = outboxItems.filter((i) => i.userId === user?.id);

  useEffect(() => {
    try {
      localStorage.setItem(TYPE_KEY, type);
    } catch {
      /* ignore */
    }
  }, [type]);

  function chooseProduct(p: Balance, meta: { fromCache: boolean }) {
    setProduct(p);
    setShown({ product: p, stale: meta.fromCache });
    setError(null);
    setTimeout(() => qtyRef.current?.focus(), 0);
  }

  function backToScan() {
    setProduct(null);
    setQty('');
    setUnitCost('');
    setDocumentRef('');
    setNotes('');
    setError(null);
    setTimeout(() => finderRef.current?.focus(), 0);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!product || busy) return;

    const quantity = parseDecimal(qty, 3);
    if (quantity === null || quantity <= 0) {
      setError('Informe uma quantidade maior que zero, com até 3 casas decimais.');
      qtyRef.current?.focus();
      return;
    }
    let cost: number | undefined;
    if (isManager && type === 'ENTRADA' && unitCost.trim()) {
      const c = parseDecimal(unitCost, 2);
      if (c === null) {
        setError('Custo unitário inválido. Use números com até 2 casas decimais.');
        return;
      }
      cost = c;
    }

    const payload: NewMovement = {
      productId: product.id,
      type,
      reason: effectiveReason,
      quantity,
      unitCost: cost,
      documentRef: documentRef.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    // Uma chave por tentativa de registro: se a resposta se perder, reenviar não duplica o lançamento.
    const key = crypto.randomUUID();
    const verb = `${TYPE_LABEL[type]} de ${fmtQty(quantity)} ${product.unit.toLowerCase()} de ${product.name}`;

    setBusy(true);
    setError(null);
    try {
      const { data } = await api.createMovement(payload, key);
      const updated: Balance = {
        ...product,
        currentStock: data.balanceAfter,
        status: statusOf(data.balanceAfter, product.safetyStock),
      };
      setShown({ product: updated, change: { before: data.balanceBefore, after: data.balanceAfter }, stale: false });
      setLog((l) => [{ id: key, text: `${verb}. Saldo: ${fmtQty(data.balanceAfter)}.`, queued: false, at: Date.now() }, ...l].slice(0, 6));
      toast.push({ tone: 'ok', text: `${TYPE_LABEL[type]} registrada: ${product.name}` });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['balances'] });
      void qc.invalidateQueries({ queryKey: ['movements'] });
      backToScan();
    } catch (err) {
      if (err instanceof NetworkError && user) {
        outbox.add({
          key,
          userId: user.id,
          payload,
          label: { productName: product.name, sku: product.sku, type, quantity, unit: product.unit },
          createdAt: Date.now(),
          status: 'pending',
        });
        setLog((l) => [{ id: key, text: `${verb}. Guardada neste aparelho; será enviada quando a conexão voltar.`, queued: true, at: Date.now() }, ...l].slice(0, 6));
        toast.push({ tone: 'info', text: 'Sem conexão: movimentação guardada neste aparelho e será enviada depois.' });
        backToScan();
      } else {
        setError(describeError(err).message);
      }
    } finally {
      setBusy(false);
    }
  }

  useHotkeys({
    'alt+e': () => setType('ENTRADA'),
    'alt+s': () => setType('SAIDA'),
    'ctrl+enter': () => void submit(),
    escape: () => {
      if (product) backToScan();
    },
    '/': () => finderRef.current?.focus(),
  });

  const submitLabel = type === 'ENTRADA' ? 'Registrar entrada' : 'Registrar saída';

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Movimentação</h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        Passe o leitor no produto, informe a quantidade e tecle Enter. Alt+E escolhe entrada, Alt+S escolhe saída, Esc volta ao leitor.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <ProductFinder ref={finderRef} onSelect={chooseProduct} autoFocus />

          <form onSubmit={submit} className="mt-5 space-y-5" aria-label="Dados da movimentação" noValidate>
            <fieldset disabled={!product || busy} className="space-y-5 disabled:opacity-50">
              <legend className="sr-only">Movimentação</legend>

              <div role="radiogroup" aria-label="Tipo de movimentação" className="grid grid-cols-2">
                {(['ENTRADA', 'SAIDA'] as const).map((t, i) => (
                  <label key={t} className={`relative ${i === 1 ? '-ml-0.5' : ''}`}>
                    <input
                      type="radio"
                      name="tipo"
                      value={t}
                      checked={type === t}
                      onChange={() => setType(t)}
                      className="peer sr-only"
                    />
                    <span className="flex h-14 items-center justify-center border-2 border-ink bg-paper text-lg font-semibold peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pallet">
                      {TYPE_LABEL[t]}
                      <span className="ml-2 text-xs font-normal opacity-70">Alt {t === 'ENTRADA' ? 'E' : 'S'}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="qty" className="block text-sm font-semibold">
                    Quantidade{product ? ` (${product.unit.toLowerCase()})` : ''}
                  </label>
                  <input
                    id="qty"
                    ref={qtyRef}
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    className="mt-1.5 h-14 w-full rounded-[3px] border-2 border-ink bg-paper px-4 text-2xl font-semibold tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="reason" className="block text-sm font-semibold">
                    Motivo
                  </label>
                  <select
                    id="reason"
                    value={effectiveReason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1.5 h-14 w-full rounded-[3px] border-2 border-ink bg-paper px-3"
                  >
                    {reasons.map((r) => (
                      <option key={r} value={r}>
                        {REASON_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <details className="border border-line bg-paper">
                <summary className="px-4 py-3 text-sm font-semibold">Mais detalhes (documento, observação{isManager && type === 'ENTRADA' ? ', custo' : ''})</summary>
                <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="doc" className="block text-sm font-semibold">
                      Nota fiscal ou pedido
                    </label>
                    <input
                      id="doc"
                      value={documentRef}
                      onChange={(e) => setDocumentRef(e.target.value)}
                      maxLength={60}
                      className="mt-1.5 h-11 w-full rounded-[3px] border-2 border-ink bg-paper px-3"
                    />
                  </div>
                  {isManager && type === 'ENTRADA' && (
                    <div>
                      <label htmlFor="cost" className="block text-sm font-semibold">
                        Custo unitário (R$)
                      </label>
                      <input
                        id="cost"
                        value={unitCost}
                        onChange={(e) => setUnitCost(e.target.value)}
                        inputMode="decimal"
                        className="mt-1.5 h-11 w-full rounded-[3px] border-2 border-ink bg-paper px-3 tabular-nums"
                      />
                    </div>
                  )}
                  <div className="sm:col-span-2">
                    <label htmlFor="obs" className="block text-sm font-semibold">
                      Observação
                    </label>
                    <textarea
                      id="obs"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      maxLength={500}
                      rows={2}
                      className="mt-1.5 w-full rounded-[3px] border-2 border-ink bg-paper p-2"
                    />
                  </div>
                </div>
              </details>

              {error && (
                <p role="alert" className="border-l-4 border-tag-red bg-paper px-3 py-2.5 text-sm font-medium">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="submit"
                  className="h-14 rounded-[3px] bg-pallet px-8 text-lg font-semibold text-white hover:bg-pallet-dark disabled:opacity-60"
                >
                  {busy ? 'Enviando…' : submitLabel}
                </button>
                <span className="text-sm text-ink-soft">Enter ou Ctrl+Enter</span>
              </div>
            </fieldset>
          </form>

          {log.length > 0 && (
            <section className="mt-8" aria-labelledby="sessao">
              <h2 id="sessao" className="mb-2 text-lg font-semibold">
                Registradas nesta sessão
              </h2>
              <ul className="divide-y divide-line border border-line bg-paper">
                {log.map((l) => (
                  <li key={l.id} className={`px-4 py-3 text-sm ${l.queued ? 'border-l-4 border-caution-fill' : ''}`}>
                    <span className="mr-2 tabular-nums text-ink-soft">{fmtDateTime(l.at)}</span>
                    {l.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {mine.length > 0 && (
            <section className="mt-8" aria-labelledby="fila">
              <h2 id="fila" className="mb-2 text-lg font-semibold">
                Aguardando envio ({mine.length})
              </h2>
              <ul className="divide-y divide-line border border-line bg-paper">
                {mine.map((i) => (
                  <li key={i.key} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium">
                        {TYPE_LABEL[i.label.type]} de {fmtQty(i.label.quantity)} {i.label.unit.toLowerCase()} de {i.label.productName}
                      </p>
                      <p className={i.status === 'failed' ? 'font-medium text-tag-red' : 'text-ink-soft'}>
                        {i.status === 'failed'
                          ? `Recusada pelo servidor: ${i.error}`
                          : `Guardada em ${fmtDateTime(i.createdAt)}. Será enviada quando a conexão voltar.`}
                      </p>
                    </div>
                    {i.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => outbox.remove(i.key)}
                        className="h-9 shrink-0 rounded-[3px] border border-ink/50 px-3 font-semibold hover:bg-concrete"
                      >
                        Descartar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {mine.some((i) => i.status === 'failed') && (
                <p className="mt-2 text-sm text-ink-soft">
                  {plural(mine.filter((i) => i.status === 'failed').length, 'Esta movimentação não', 'Estas movimentações não')} foi
                  aplicada ao estoque. Descarte e registre de novo com os dados corretos.
                </p>
              )}
            </section>
          )}
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          {shown ? (
            <ShelfTag product={shown.product} change={shown.change} stale={shown.stale} />
          ) : (
            <div className="rounded-[3px] border-2 border-dashed border-line p-6 text-ink-soft">
              <p className="font-medium text-ink">Nenhum produto na etiqueta</p>
              <p className="mt-1 text-sm">Ao identificar um produto, a etiqueta mostra o saldo atual e o código de barras.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
