import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Balance } from '../types';

const bal = (over: Partial<Balance>): Balance => ({
  id: 'x',
  sku: 'SKU',
  barcode: null,
  name: 'Produto',
  unit: 'UN',
  currentStock: 1,
  safetyStock: 0,
  status: 'OK',
  ...over,
});

describe('describeError: mensagens para o usuário (o que houve e o que fazer)', () => {
  async function load() {
    vi.resetModules();
    return { ...(await import('../errors')), ...(await import('../http')) };
  }

  it.each([
    ['timeout', /demorou demais/],
    ['offline', /sem internet/],
    ['unavailable', /indisponível/],
    ['unreachable', /conectar ao servidor/],
  ] as const)('falha de rede (%s) é marcada como "network" e explicada', async (kind, text) => {
    const { describeError, NetworkError } = await load();
    const d = describeError(new NetworkError(kind, 'x'));
    expect(d.network).toBe(true);
    expect(d.message).toMatch(text);
  });

  it('limite de requisições informa quanto esperar (Retry-After) ou usa 60 s', async () => {
    const { describeError, ApiError } = await load();
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', undefined, undefined, 25)).message).toMatch(/25 segundos/);
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x')).message).toMatch(/60 segundos/);
  });

  it.each([
    ['INVALID_CREDENTIALS', /E-mail ou senha incorretos/],
    ['VALIDATION_ERROR', /Confira os campos/],
    ['FORBIDDEN', /perfil não permite/],
    ['FORBIDDEN_FIELD', /perfil não permite/],
    ['TOKEN_EXPIRED', /sessão expirou/],
    ['INVALID_TOKEN', /sessão expirou/],
    ['UNAUTHENTICATED', /sessão expirou/],
  ])('erro do servidor %s vira texto em português, sem marcar como rede', async (code, text) => {
    const { describeError, ApiError } = await load();
    const d = describeError(new ApiError(400, code, 'texto técnico'));
    expect(d.network).toBe(false);
    expect(d.message).toMatch(text);
  });

  it('erro de negócio sem tradução usa a mensagem do próprio servidor (ex.: saldo insuficiente)', async () => {
    const { describeError, ApiError } = await load();
    expect(describeError(new ApiError(422, 'INSUFFICIENT_STOCK', 'estoque insuficiente (saldo 1, solicitado 2)')).message).toBe(
      'estoque insuficiente (saldo 1, solicitado 2)',
    );
  });

  it('erro desconhecido vira mensagem genérica', async () => {
    const { describeError } = await load();
    expect(describeError(new Error('qualquer coisa interna'))).toEqual({ message: 'Algo deu errado. Tente novamente.', network: false });
  });
});

describe('cache local de produtos (uso sem conexão)', () => {
  beforeEach(() => localStorage.clear());

  async function load() {
    vi.resetModules();
    return (await import('../productCache')).productCache;
  }

  it('lembra os produtos consultados e encontra por código de barras exato, SKU exato ou nome parcial', async () => {
    const cache = await load();
    cache.remember([
      bal({ id: '1', sku: 'CAFE-500', barcode: '7891000100103', name: 'Café Torrado 500g' }),
      bal({ id: '2', sku: 'ARROZ-5', barcode: '7891000200205', name: 'Arroz 5kg' }),
    ]);
    expect(cache.find('7891000100103').map((p) => p.id)).toEqual(['1']);
    expect(cache.find('arroz-5').map((p) => p.id)).toEqual(['2']);
    expect(cache.find('torrado').map((p) => p.id)).toEqual(['1']);
    expect(cache.find('CAFE').map((p) => p.id)).toEqual(['1']); // SKU parcial
  });

  it('busca exata tem prioridade sobre a parcial', async () => {
    const cache = await load();
    cache.remember([bal({ id: '1', sku: 'A', name: 'Produto A' }), bal({ id: '2', sku: 'AB', name: 'Produto AB' })]);
    expect(cache.find('a').map((p) => p.id)).toEqual(['1']);
  });

  it('termo vazio, produto desconhecido ou lista vazia não devolvem nada', async () => {
    const cache = await load();
    cache.remember([]);
    cache.remember([bal({ id: '1', name: 'Café' })]);
    expect(cache.find('')).toEqual([]);
    expect(cache.find('   ')).toEqual([]);
    expect(cache.find('inexistente')).toEqual([]);
  });

  it('respeita o limite de resultados e não vaza o carimbo interno (cachedAt)', async () => {
    const cache = await load();
    cache.remember(Array.from({ length: 12 }, (_, i) => bal({ id: String(i), sku: `P-${i}`, name: `Produto ${i}` })));
    const found = cache.find('produto', 5);
    expect(found).toHaveLength(5);
    expect(found[0]).not.toHaveProperty('cachedAt');
  });

  it('atualizar um produto substitui o saldo guardado', async () => {
    const cache = await load();
    cache.remember([bal({ id: '1', name: 'Café', currentStock: 5 })]);
    cache.remember([bal({ id: '1', name: 'Café', currentStock: 9 })]);
    expect(cache.find('café')[0].currentStock).toBe(9);
  });

  it('armazenamento corrompido ou indisponível não derruba o app', async () => {
    const cache = await load();
    localStorage.setItem('estoque.products.v1', '{json quebrado');
    expect(cache.find('qualquer')).toEqual([]);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cota excedida');
    });
    expect(() => cache.remember([bal({ id: '1' })])).not.toThrow();
    spy.mockRestore();
  });
});
