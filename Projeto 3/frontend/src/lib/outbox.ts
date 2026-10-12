import { api } from './api';
import { ApiError, NetworkError } from './http';
import type { MovementType, NewMovement } from './types';

/**
 * Fila de movimentações que não chegaram ao servidor (queda de rede ou timeout).
 *  - Fica no localStorage, então sobrevive a recarregar a página;
 *  - cada item guarda a Idempotency-Key gerada no momento do registro: se o servidor tinha
 *    processado a primeira tentativa (timeout "ambíguo"), o reenvio devolve a mesma movimentação
 *    em vez de lançar em duplicidade;
 *  - só o usuário que registrou reenvia (o servidor atribui a movimentação a quem está logado);
 *  - recusa de negócio (ex.: saldo insuficiente) marca o item como "failed" para revisão humana.
 */
const KEY = 'estoque.outbox.v1';

export interface OutboxItem {
  key: string;
  userId: string;
  payload: NewMovement;
  label: { productName: string; sku: string; type: MovementType; quantity: number; unit: string };
  createdAt: number;
  status: 'pending' | 'failed';
  error?: string;
}

function read(): OutboxItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? (raw as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

let items: OutboxItem[] = read();
const listeners = new Set<() => void>();
let flushing = false;

function commit(next: OutboxItem[]) {
  items = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* sem armazenamento: a fila vale só até recarregar */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  // outra aba alterou a fila
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      items = read();
      listeners.forEach((l) => l());
    }
  });
}

export interface FlushResult {
  sent: number;
  failed: number;
  stopped: boolean;
}

export const outbox = {
  getSnapshot: () => items,

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  add(item: OutboxItem) {
    commit([...items, item]);
  },

  remove(key: string) {
    commit(items.filter((i) => i.key !== key));
  },

  async flush(userId: string): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, failed: 0, stopped: false };
    if (flushing) return result;
    flushing = true;
    try {
      for (const item of items.filter((i) => i.userId === userId && i.status === 'pending')) {
        try {
          await api.createMovement(item.payload, item.key);
          commit(items.filter((i) => i.key !== item.key));
          result.sent++;
        } catch (e) {
          if (e instanceof NetworkError || (e instanceof ApiError && (e.status === 401 || e.status === 429 || e.status >= 500))) {
            result.stopped = true; // tenta de novo mais tarde, mantendo a ordem
            break;
          }
          const message = e instanceof ApiError ? e.message : 'Falha inesperada ao enviar.';
          commit(items.map((i) => (i.key === item.key ? { ...i, status: 'failed', error: message } : i)));
          result.failed++;
        }
      }
    } finally {
      flushing = false;
    }
    return result;
  },
};
