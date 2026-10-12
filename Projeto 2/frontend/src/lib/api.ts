const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
const REQUEST_TIMEOUT_MS = 8_000;

export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || 'Não foi possível concluir a solicitação.', response.status, payload?.error?.code);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('O servidor demorou para responder. Confira a conexão e tente novamente.', undefined, 'TIMEOUT');
    }
    throw new ApiError('Servidor indisponível. Verifique sua conexão e tente novamente.', undefined, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export type Balance = {
  product_id: number;
  sku: string;
  barcode: string | null;
  name: string;
  safety_stock: number;
  quantity_on_hand: number;
  is_below_safety_stock: boolean;
};
