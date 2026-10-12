import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const user = { id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'ESTOQUISTA' as const };

function res(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

function hangUntilAborted(_url: unknown, init: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

async function load() {
  vi.resetModules();
  const http = await import('../http');
  const session = await import('../session');
  const connection = await import('../connection');
  return { ...http, session: session.session, connection: connection.connection };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cliente HTTP: timeout e novas tentativas', () => {
  it('devolve o corpo em caso de sucesso', async () => {
    const { request } = await load();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, { ok: true })));
    await expect(request('/stock/alerts')).resolves.toEqual({ ok: true });
  });

  it('estoura o timeout e vira NetworkError("timeout")', async () => {
    const { request, NetworkError } = await load();
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted));
    const err: any = await request('/stock/alerts', { timeoutMs: 40, retries: 0 }).catch((e: any) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.kind).toBe('timeout');
  });

  it('repete GET com backoff após falha de rede e acaba com sucesso', async () => {
    const { request } = await load();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(res(200, { data: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/stock/alerts')).resolves.toEqual({ data: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('desiste após esgotar as tentativas e lança NetworkError', async () => {
    const { request, NetworkError } = await load();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/stock/alerts')).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 repetições
  }, 10_000);

  it('trata 503 com envelope da API como servidor indisponível e repete o GET', async () => {
    const { request } = await load();
    const unavailable = res(503, { error: { code: 'DB_UNAVAILABLE', message: 'Banco indisponível' } }, { 'Retry-After': '1' });
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(res(200, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/stock/alerts')).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('trata 5xx sem envelope (proxy/gateway) como servidor indisponível', async () => {
    const { request, NetworkError } = await load();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(500)));
    const err: any = await request('/stock/alerts', { retries: 0 }).catch((e: any) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.kind).toBe('unavailable');
  });

  it('NÃO repete POST sem Idempotency-Key', async () => {
    const { request, NetworkError } = await load();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/stock/movements', { method: 'POST', body: { a: 1 } })).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('repete POST com Idempotency-Key, enviando a mesma chave', async () => {
    const { request } = await load();
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(res(201, { data: { id: 7 } }));
    vi.stubGlobal('fetch', fetchMock);
    const key = '0b5f0c2e-6b1a-4c53-a5d1-2f7a4d2f9a10';
    await expect(request('/stock/movements', { method: 'POST', body: {}, idempotencyKey: key })).resolves.toEqual({ data: { id: 7 } });
    const sent = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>);
    expect(sent.map((h) => h['Idempotency-Key'])).toEqual([key, key]);
  }, 10_000);

  it('erro de negócio (422) vira ApiError e não é repetido', async () => {
    const { request, ApiError } = await load();
    const body = { error: { code: 'INSUFFICIENT_STOCK', message: 'estoque insuficiente (saldo 3, solicitado 9)', requestId: 'r-1' } };
    const fetchMock = vi.fn().mockResolvedValue(res(422, body));
    vi.stubGlobal('fetch', fetchMock);
    const err: any = await request('/stock/movements', { method: 'POST', body: {}, idempotencyKey: 'k' }).catch((e: any) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.status).toBe(422);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancelamento por quem chamou não é tratado como falha de rede', async () => {
    const { request, connection } = await load();
    vi.stubGlobal('fetch', vi.fn(hangUntilAborted));
    const ctrl = new AbortController();
    const p = request('/stock/alerts', { signal: ctrl.signal, retries: 0 });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.getState().failures).toBe(0);
  });
});

describe('cliente HTTP: renovação de sessão', () => {
  it('várias requisições com token vencido compartilham UMA renovação', async () => {
    const { request, session } = await load();
    session.set({ accessToken: 'old', refreshToken: 'r1', user });
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/auth/refresh')) {
          refreshCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return res(200, { accessToken: 'new', refreshToken: 'r2', tokenType: 'Bearer', expiresIn: 900, user });
        }
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === 'Bearer new' ? res(200, { ok: true }) : res(401, { error: { code: 'TOKEN_EXPIRED', message: 'Token expirado.' } });
      }),
    );
    const out = await Promise.all([request('/stock/alerts'), request('/stock/balances'), request('/stock/movements')]);
    expect(out).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
    expect(session.getRefreshToken()).toBe('r2');
  });

  it('queda de rede durante a renovação NÃO derruba a sessão', async () => {
    const { request, session, NetworkError } = await load();
    session.set({ accessToken: 'old', refreshToken: 'r1', user });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/refresh') ? Promise.reject(new TypeError('fetch failed')) : res(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } }),
      ),
    );
    await expect(request('/stock/alerts', { retries: 0 })).rejects.toBeInstanceOf(NetworkError);
    expect(session.getRefreshToken()).toBe('r1');
    expect(session.getUser()).not.toBeNull();
  });

  it('refresh rejeitado pelo servidor encerra a sessão e avisa', async () => {
    const { request, session, ApiError } = await load();
    session.set({ accessToken: 'old', refreshToken: 'r1', user });
    const expired = vi.fn();
    session.onExpired(expired);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/auth/refresh')
          ? res(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Sessão inválida' } })
          : res(401, { error: { code: 'TOKEN_EXPIRED', message: 'x' } }),
      ),
    );
    await expect(request('/stock/alerts', { retries: 0 })).rejects.toBeInstanceOf(ApiError);
    expect(session.getUser()).toBeNull();
    expect(session.getRefreshToken()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });
});
