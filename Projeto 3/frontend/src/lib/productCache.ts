import type { Balance } from './types';

/**
 * Cache local dos produtos já consultados. Permite identificar um produto (por código de barras,
 * SKU ou nome) e registrar a movimentação mesmo com o servidor fora do ar. O saldo guardado
 * pode estar desatualizado; a interface avisa quando usa este cache.
 */
const KEY = 'estoque.products.v1';
const MAX = 3_000;

type Cached = Balance & { cachedAt: number };

function load(): Record<string, Cached> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Cached>;
  } catch {
    return {};
  }
}

export const productCache = {
  remember(items: Balance[]) {
    if (!items.length) return;
    try {
      const map = load();
      const now = Date.now();
      for (const p of items) map[p.id] = { ...p, cachedAt: now };
      const entries = Object.entries(map);
      if (entries.length > MAX) {
        entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(0, MAX))));
      } else {
        localStorage.setItem(KEY, JSON.stringify(map));
      }
    } catch {
      /* cache é opcional */
    }
  },

  find(term: string, limit = 8): Balance[] {
    const t = term.trim().toLowerCase();
    if (!t) return [];
    const all = Object.values(load());
    const exact = all.filter((p) => p.barcode === t || p.sku.toLowerCase() === t);
    const found = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t));
    return found.slice(0, limit).map(({ cachedAt: _cachedAt, ...p }) => p);
  },
};
