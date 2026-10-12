import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return (await import('../connection')).connection;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('monitor de conexão', () => {
  it('uma falha isolada não marca offline; duas seguidas marcam', async () => {
    const connection = await load();
    connection.reportFailure();
    expect(connection.getState().status).toBe('online');
    connection.reportFailure();
    expect(connection.getState().status).toBe('offline');
    expect(connection.getState().nextProbeAt).not.toBeNull();
  });

  it('um sucesso entre as falhas zera a contagem', async () => {
    const connection = await load();
    connection.reportFailure();
    connection.reportSuccess();
    connection.reportFailure();
    expect(connection.getState().status).toBe('online');
  });

  it('sonda /health, volta a ficar online e dispara a reconexão uma única vez', async () => {
    const connection = await load();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onReconnect = vi.fn();
    connection.onReconnect(onReconnect);

    connection.reportFailure();
    connection.reportFailure();
    await vi.advanceTimersByTimeAsync(4_100);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/health');
    expect(connection.getState().status).toBe('online');
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('enquanto o servidor segue fora, continua sondando com intervalo crescente', async () => {
    const connection = await load();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    connection.reportFailure();
    connection.reportFailure();
    await vi.advanceTimersByTimeAsync(4_100); // 1ª sondagem
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connection.getState().status).toBe('offline');

    const next1 = connection.getState().nextProbeAt! - Date.now();
    expect(next1).toBeGreaterThan(5_000); // 4 s × 1,5
    await vi.advanceTimersByTimeAsync(next1 + 50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const next2 = connection.getState().nextProbeAt! - Date.now();
    expect(next2).toBeGreaterThan(next1 - 100);
  });

  it('"tentar agora" sonda sem esperar o intervalo', async () => {
    const connection = await load();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    connection.reportFailure();
    connection.reportFailure();
    connection.probeNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connection.getState().status).toBe('online');
  });
});
