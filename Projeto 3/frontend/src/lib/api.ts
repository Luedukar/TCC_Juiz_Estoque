import { request } from './http';
import { productCache } from './productCache';
import type {
  AlertsResponse,
  Balance,
  Movement,
  MovementType,
  NewMovement,
  Page,
  StockStatus,
  TokenResponse,
} from './types';

export interface BalancesQuery {
  barcode?: string;
  sku?: string;
  q?: string;
  status?: StockStatus;
  limit?: number;
  offset?: number;
}

export interface MovementsQuery {
  productId?: string;
  type?: MovementType;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  login: (email: string, password: string) =>
    request<TokenResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false, retries: 0 }),

  logout: (refreshToken: string) =>
    request<void>('/auth/logout', { method: 'POST', body: { refreshToken }, auth: false, retries: 0, timeoutMs: 4_000 }),

  alerts: (signal?: AbortSignal) => request<AlertsResponse>('/stock/alerts', { signal }),

  async balances(query: BalancesQuery, signal?: AbortSignal) {
    const page = await request<Page<Balance>>('/stock/balances', { query, signal });
    productCache.remember(page.data);
    return page;
  },

  movements: (query: MovementsQuery, signal?: AbortSignal) => request<Page<Movement>>('/stock/movements', { query, signal }),

  createMovement: (body: NewMovement, idempotencyKey: string) =>
    request<{ data: Movement }>('/stock/movements', { method: 'POST', body, idempotencyKey, retries: 1 }),

  reverseMovement: (id: number, notes: string | undefined, idempotencyKey: string) =>
    request<{ data: Movement }>(`/stock/movements/${id}/reversal`, {
      method: 'POST',
      body: notes ? { notes } : {},
      idempotencyKey,
      retries: 1,
    }),
};
