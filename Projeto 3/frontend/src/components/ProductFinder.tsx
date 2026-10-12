import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { describeError } from '../lib/errors';
import { NetworkError } from '../lib/http';
import { productCache } from '../lib/productCache';
import { fmtQty } from '../lib/format';
import type { Balance } from '../lib/types';
import { StatusBadge } from './StatusBadge';

export interface FinderHandle {
  focus: () => void;
}

interface Props {
  onSelect: (product: Balance, meta: { fromCache: boolean }) => void;
  label?: string;
  autoFocus?: boolean;
}

type Phase = 'idle' | 'loading' | 'choose' | 'empty' | 'error';

const isBarcodeLike = (t: string) => /^\d{8,14}$/.test(t);

/**
 * Campo único para leitor de código de barras, SKU ou nome.
 *  - leitor (teclado virtual + Enter): busca exata por código de barras, depois SKU, depois nome;
 *  - digitando um nome: sugestões enquanto escreve; ↑ ↓ e Enter escolhem;
 *  - sem conexão: usa o cache local de produtos já consultados.
 */
export const ProductFinder = forwardRef<FinderHandle, Props>(function ProductFinder(
  { onSelect, label = 'Código de barras, SKU ou nome', autoFocus },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Balance[]>([]);
  const [fromCache, setFromCache] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  function reset() {
    setTerm('');
    setResults([]);
    setPhase('idle');
    setMessage(null);
    setActive(0);
    setFromCache(false);
  }

  function pick(p: Balance, cached: boolean) {
    reset();
    onSelect(p, { fromCache: cached });
  }

  // sugestões enquanto digita um nome (não para códigos de barras: o leitor termina com Enter)
  useEffect(() => {
    const t = term.trim();
    if (t.length < 2 || isBarcodeLike(t)) {
      setResults([]);
      setPhase((p) => (p === 'choose' ? 'idle' : p));
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const page = await api.balances({ q: t, limit: 6 }, ctrl.signal);
        setResults(page.data);
        setFromCache(false);
        setActive(0);
        setPhase(page.data.length ? 'choose' : 'empty');
        setMessage(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof NetworkError) {
          const cached = productCache.find(t, 6);
          setResults(cached);
          setFromCache(true);
          setActive(0);
          setPhase(cached.length ? 'choose' : 'error');
          setMessage(cached.length ? null : describeError(e).message);
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [term]);

  async function resolve(raw: string) {
    const t = raw.trim();
    if (!t) return;
    setPhase('loading');
    setMessage(null);
    try {
      let list: Balance[] = [];
      if (isBarcodeLike(t)) list = (await api.balances({ barcode: t, limit: 5 })).data;
      if (!list.length) list = (await api.balances({ sku: t, limit: 5 })).data;
      if (!list.length) list = (await api.balances({ q: t, limit: 8 })).data;

      if (list.length === 1) return pick(list[0], false);
      if (list.length > 1) {
        setResults(list);
        setFromCache(false);
        setActive(0);
        setPhase('choose');
        return;
      }
      setPhase('empty');
    } catch (e) {
      if (e instanceof NetworkError) {
        const cached = productCache.find(t, 8);
        if (cached.length === 1) return pick(cached[0], true);
        if (cached.length > 1) {
          setResults(cached);
          setFromCache(true);
          setActive(0);
          setPhase('choose');
          return;
        }
      }
      setPhase('error');
      setMessage(describeError(e).message);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (phase === 'choose' && results[active]) pick(results[active], fromCache);
      else void resolve(term);
    } else if (e.key === 'Escape' && term) {
      e.stopPropagation();
      reset();
    }
  }

  return (
    <div>
      <label htmlFor={`${listId}-input`} className="block text-sm font-semibold">
        {label}
      </label>
      <input
        ref={inputRef}
        id={`${listId}-input`}
        type="text"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          if (phase === 'empty' || phase === 'error') setPhase('idle');
        }}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="text"
        role="combobox"
        aria-expanded={phase === 'choose'}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="Passe o leitor ou digite e tecle Enter"
        className="mt-1.5 h-14 w-full rounded-[3px] border-2 border-ink bg-paper px-4 text-lg placeholder:text-ink-soft/70"
      />

      <div aria-live="polite" className="min-h-6">
        {phase === 'loading' && <p className="mt-2 text-sm text-ink-soft">Buscando produto…</p>}
        {phase === 'empty' && (
          <p className="mt-2 text-sm font-medium">Nenhum produto encontrado para “{term.trim()}”. Confira o código digitado.</p>
        )}
        {phase === 'error' && message && (
          <p role="alert" className="mt-2 border-l-4 border-tag-red bg-paper px-3 py-2 text-sm font-medium">
            {message}
          </p>
        )}
      </div>

      {phase === 'choose' && results.length > 0 && (
        <div className="mt-1">
          {fromCache && (
            <p className="mb-1 text-sm font-medium text-caution">Sem conexão: lista guardada neste aparelho, saldos podem estar desatualizados.</p>
          )}
          <ul id={listId} role="listbox" className="divide-y divide-line border border-line bg-paper">
            {results.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onClick={() => pick(p, fromCache)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${i === active ? 'bg-pallet-wash' : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="font-mono text-xs text-ink-soft">{p.sku}</span>
                  </span>
                  <span className="shrink-0 text-right text-sm">
                    <span className="block font-semibold tabular-nums">{fmtQty(p.currentStock)}</span>
                    <StatusBadge status={p.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});
