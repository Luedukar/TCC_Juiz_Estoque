import { API_BASE } from './config';
import { connection } from './connection';
import { session } from './session';
import type { TokenResponse } from './types';

export type NetworkKind = 'timeout' | 'offline' | 'unreachable' | 'unavailable';

/** O servidor não respondeu (ou respondeu 502/503/504): vale tentar de novo / guardar para depois. */
export class NetworkError extends Error {
  kind: NetworkKind;
  retryAfter?: number;
  constructor(kind: NetworkKind, message: string, retryAfter?: number) {
    super(message);
    this.name = 'NetworkError';
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

/** O servidor respondeu com um erro de negócio no formato padrão { error: { code, message, ... } }. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  requestId?: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: object;
  /** Torna o POST seguro para repetir: o servidor devolve a movimentação original em vez de duplicar. */
  idempotencyKey?: string;
  auth?: boolean;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 10_000;

function buildUrl(path: string, query?: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function backoff(attempt: number, retryAfter?: number): number {
  if (retryAfter) return Math.min(retryAfter * 1000, 5_000);
  return Math.min(400 * 2 ** attempt, 3_000) * (0.75 + Math.random() * 0.5);
}

async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const n = Number(res.headers.get('retry-after'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Uma tentativa de rede, com timeout. Converte falhas de transporte em NetworkError. */
async function send(path: string, o: RequestOptions, useAuth: boolean): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, o.timeoutMs ?? DEFAULT_TIMEOUT);
  const onExternalAbort = () => ctrl.abort();
  o.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  const token = session.getAccessToken();
  if (useAuth && token) headers.Authorization = `Bearer ${token}`;

  try {
    return await fetch(buildUrl(path, o.query), {
      method: o.method ?? 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (o.signal?.aborted) throw err; // cancelado por quem chamou (ex.: troca de tela): não é falha de rede
    if (timedOut) throw new NetworkError('timeout', 'O servidor demorou para responder.');
    throw new NetworkError(navigator.onLine ? 'unreachable' : 'offline', 'Sem conexão com o servidor.');
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onExternalAbort);
  }
}

let refreshing: Promise<boolean> | null = null;

/** Renova o access token. Várias requisições com token vencido compartilham uma única renovação. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = session.getRefreshToken();
  if (!refreshToken) {
    session.clear();
    session.notifyExpired();
    return false;
  }
  try {
    const t = await request<TokenResponse>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      auth: false,
      retries: 0,
    });
    session.set(t);
    return true;
  } catch (e) {
    // Só encerra a sessão se o servidor rejeitou o token. Queda de rede NÃO desloga o usuário.
    if (e instanceof ApiError && e.status === 401) {
      session.clear();
      session.notifyExpired();
      return false;
    }
    throw e;
  }
}

const isTokenProblem = (body: any) => ['TOKEN_EXPIRED', 'INVALID_TOKEN'].includes(body?.error?.code);

/**
 * Cliente HTTP da aplicação:
 *  - timeout por tentativa (10 s por padrão);
 *  - até 2 novas tentativas com backoff exponencial em GET e em POST com Idempotency-Key;
 *  - 502/503/504 (e 5xx sem o envelope de erro da API, típico de proxy) contam como "servidor indisponível";
 *  - token expirado => renova uma vez (single-flight) e repete a requisição.
 */
export async function request<T>(path: string, o: RequestOptions = {}): Promise<T> {
  const method = o.method ?? 'GET';
  const safeToRepeat = method === 'GET' || !!o.idempotencyKey;
  const maxRetries = o.retries ?? (safeToRepeat ? 2 : 0);
  const useAuth = o.auth !== false;
  let refreshedOnce = false;

  for (let attempt = 0; ; attempt++) {
    try {
      let res = await send(path, o, useAuth);
      let body = await readBody(res);

      if (res.status === 401 && useAuth && !refreshedOnce && isTokenProblem(body)) {
        refreshedOnce = true;
        if (await refreshSession()) {
          res = await send(path, o, useAuth);
          body = await readBody(res);
        }
      }

      if (res.ok) {
        connection.reportSuccess();
        return body as T;
      }

      const retryAfter = parseRetryAfter(res);
      const code: string | undefined = body?.error?.code;
      if (res.status >= 500 && (!code || res.status === 502 || res.status === 503 || res.status === 504)) {
        throw new NetworkError('unavailable', body?.error?.message ?? 'O servidor está indisponível.', retryAfter);
      }

      connection.reportSuccess(); // o servidor respondeu: está no ar, mesmo que tenha recusado o pedido
      throw new ApiError(
        res.status,
        code ?? 'HTTP_ERROR',
        body?.error?.message ?? res.statusText,
        body?.error?.details,
        body?.error?.requestId,
        retryAfter,
      );
    } catch (e) {
      if (e instanceof NetworkError) {
        connection.reportFailure();
        if (attempt < maxRetries && !o.signal?.aborted) {
          await sleep(backoff(attempt, e.retryAfter), o.signal);
          continue;
        }
      }
      throw e;
    }
  }
}
