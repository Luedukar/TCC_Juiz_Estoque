import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxItem } from '../outbox';

vi.mock('../api', () => ({ api: { createMovement: vi.fn() } }));

async function load() {
  vi.resetModules();
  const { api } = await import('../api');
  const http = await import('../http');
  const { outbox } = await import('../outbox');
  return { api: api as unknown as { createMovement: ReturnType<typeof vi.fn> }, outbox, ...http };
}

const item = (key: string, userId = 'u1'): OutboxItem => ({
  key,
  userId,
  payload: { productId: 'p1', type: 'SAIDA', quantity: 2 },
  label: { productName: 'Café 500g', sku: 'CAFE-500', type: 'SAIDA', quantity: 2, unit: 'UN' },
  createdAt: 1_700_000_000_000,
  status: 'pending',
});

beforeEach(() => {
  localStorage.clear();
});

describe('fila de envio offline', () => {
  it('guarda no localStorage e sobrevive a recarregar a página', async () => {
    const first = await load();
    first.outbox.add(item('k1'));
    const second = await load(); // simula recarregar
    expect(second.outbox.getSnapshot().map((i) => i.key)).toEqual(['k1']);
  });

  it('envia na ordem, com a Idempotency-Key original, e remove os enviados', async () => {
    const { api, outbox } = await load();
    api.createMovement.mockResolvedValue({ data: {} });
    outbox.add(item('k1'));
    outbox.add(item('k2'));
    const r = await outbox.flush('u1');
    expect(r).toEqual({ sent: 2, failed: 0, stopped: false });
    expect(api.createMovement.mock.calls.map((c) => c[1])).toEqual(['k1', 'k2']);
    expect(outbox.getSnapshot()).toHaveLength(0);
  });

  it('para no primeiro erro de rede e mantém tudo pendente', async () => {
    const { api, outbox, NetworkError } = await load();
    api.createMovement.mockRejectedValue(new NetworkError('unreachable', 'sem conexão'));
    outbox.add(item('k1'));
    outbox.add(item('k2'));
    const r = await outbox.flush('u1');
    expect(r.stopped).toBe(true);
    expect(api.createMovement).toHaveBeenCalledTimes(1);
    expect(outbox.getSnapshot().every((i) => i.status === 'pending')).toBe(true);
  });

  it('recusa de negócio marca o item como "failed" e segue para o próximo', async () => {
    const { api, outbox, ApiError } = await load();
    api.createMovement
      .mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_STOCK', 'estoque insuficiente (saldo 1, solicitado 2)'))
      .mockResolvedValueOnce({ data: {} });
    outbox.add(item('k1'));
    outbox.add(item('k2'));
    const r = await outbox.flush('u1');
    expect(r).toEqual({ sent: 1, failed: 1, stopped: false });
    const left = outbox.getSnapshot();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ key: 'k1', status: 'failed', error: 'estoque insuficiente (saldo 1, solicitado 2)' });
  });

  it('só reenvia itens do usuário logado', async () => {
    const { api, outbox } = await load();
    api.createMovement.mockResolvedValue({ data: {} });
    outbox.add(item('mine', 'u1'));
    outbox.add(item('theirs', 'u2'));
    await outbox.flush('u1');
    expect(outbox.getSnapshot().map((i) => i.key)).toEqual(['theirs']);
  });

  it('429 e 5xx pausam o envio sem marcar como falha', async () => {
    const { api, outbox, ApiError } = await load();
    api.createMovement.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'muitas requisições'));
    outbox.add(item('k1'));
    const r = await outbox.flush('u1');
    expect(r).toEqual({ sent: 0, failed: 0, stopped: true });
    expect(outbox.getSnapshot()[0].status).toBe('pending');
  });

  it('dois envios simultâneos não processam o mesmo item duas vezes', async () => {
    const { api, outbox } = await load();
    api.createMovement.mockImplementation(() => new Promise((r) => setTimeout(() => r({ data: {} }), 20)));
    outbox.add(item('k1'));
    await Promise.all([outbox.flush('u1'), outbox.flush('u1')]);
    expect(api.createMovement).toHaveBeenCalledTimes(1);
  });
});
