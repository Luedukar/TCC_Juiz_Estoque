import type { ApiEnvelope, LoginResponse, LowStockProduct } from './types';

const API_URL = import.meta.env.VITE_API_URL ?? '/api';
const REQUEST_TIMEOUT_MS = 8_000;
const READ_RETRIES = 2;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  token?: string;
  body?: unknown;
  retries?: number;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Request cancelled', 'AbortError'));
      return;
    }

    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    const cancel = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    token,
    body,
    retries = 0,
    signal: requestSignal,
    headers: suppliedHeaders,
    ...init
  } = options;
  const outerSignal = requestSignal ?? undefined;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    outerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let payload: { error?: { code?: string; message?: string } } | null;

    try {
      response = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...suppliedHeaders
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const responseText = await response.text();
      try {
        payload = JSON.parse(responseText) as { error?: { code?: string; message?: string } } | null;
      } catch {
        payload = null;
      }
    } catch (error) {
      window.clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', abortFromCaller);
      if (outerSignal?.aborted) {
        throw new DOMException('Request cancelled', 'AbortError');
      }
      if (attempt < retries) {
        await wait(300 * (attempt + 1), outerSignal);
        continue;
      }
      const detail = error instanceof DOMException && error.name === 'AbortError'
        ? 'O servidor demorou demais para responder.'
        : 'Não foi possível conectar ao servidor.';
      throw new ApiError(`${detail} Verifique sua conexão e tente novamente.`, undefined, 'NETWORK_ERROR');
    } finally {
      window.clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', abortFromCaller);
    }

    if ([502, 503, 504].includes(response.status) && attempt < retries) {
      await wait(300 * (attempt + 1), outerSignal);
      continue;
    }

    if (!response.ok) {
      throw new ApiError(
        payload?.error?.message ?? 'O servidor não conseguiu concluir a solicitação.',
        response.status,
        payload?.error?.code
      );
    }
    return payload as T;
  }
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await request<ApiEnvelope<LoginResponse>>('/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  return response.data;
}

export async function getLowStock(
  token: string,
  signal?: AbortSignal
): Promise<LowStockProduct[]> {
  const response = await request<ApiEnvelope<LowStockProduct[]>>('/inventory/low-stock', {
    method: 'GET',
    token,
    signal,
    retries: READ_RETRIES
  });
  return response.data;
}
