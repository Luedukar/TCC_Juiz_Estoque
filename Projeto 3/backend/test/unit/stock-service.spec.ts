import { AppError } from '../../src/common/app-error';
import { StockService } from '../../src/stock/stock.service';

const PID = '0b5f0c2e-6b1a-4c53-a5d1-2f7a4d2f9a10';
const KEY = '9d3c1a52-7a43-4f6e-8a56-1b0c5c5a9e11';
const manager = { id: 'm1', role: 'GERENTE' as const };
const clerk = { id: 'c1', role: 'ESTOQUISTA' as const };

const kardexRow = (over: Record<string, unknown> = {}) => ({
  id: '7',
  created_at: new Date('2026-10-09T18:00:00Z'),
  product_id: PID,
  sku: 'A',
  product_name: 'Produto A',
  type: 'ENTRADA',
  reason: 'COMPRA',
  quantity: '5',
  signed_quantity: '5',
  balance_before: '0',
  balance_after: '5',
  unit_cost: null,
  document_ref: null,
  notes: null,
  reversal_of_id: null,
  reversed_by_id: null,
  user_name: 'Ana',
  supplier_name: null,
  ...over,
});

/** Banco simulado: `tx` executa o callback com um client falso que registra as consultas. */
function setup(opts: { productRows?: any[]; client?: (sql: string, params: any[]) => any } = {}) {
  const clientCalls: { sql: string; params: any[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      clientCalls.push({ sql, params });
      if (opts.client) return opts.client(sql, params);
      if (/INSERT INTO stock_movements/.test(sql)) return { rows: [{ id: '7' }] };
      if (/FROM v_kardex/.test(sql)) return { rows: [kardexRow()] };
      return { rows: [] };
    }),
  };
  const db: any = {
    query: jest.fn(async (sql: string) => {
      if (/FROM products WHERE/.test(sql)) return { rows: opts.productRows ?? [{ id: PID }] };
      return { rows: [] };
    }),
    tx: jest.fn(async (_uid: string, fn: any) => fn(client)),
  };
  return { service: new StockService(db), db, client, clientCalls };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as AppError & { code?: string };
  }
};

describe('StockService.create: regras antes de chegar ao banco', () => {
  it('Estoquista não pode informar custo (403 FORBIDDEN_FIELD) e nada é consultado', async () => {
    const { service, db } = setup();
    const e = await failure(service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 1, unitCost: 5 }, null));
    expect(e).toMatchObject({ code: 'FORBIDDEN_FIELD' });
    expect(e!.getStatus()).toBe(403);
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('custo em SAÍDA é inválido, mesmo para o Gerente (400)', async () => {
    const { service } = setup();
    const e = await failure(service.create(manager, { productId: PID, type: 'SAIDA', quantity: 1, unitCost: 5 }, null));
    expect(e).toMatchObject({ code: 'INVALID_FIELD' });
    expect(e!.getStatus()).toBe(400);
  });

  it('motivo incompatível com o tipo é recusado e informa os permitidos', async () => {
    const { service } = setup();
    const e = await failure(service.create(clerk, { productId: PID, type: 'SAIDA', reason: 'COMPRA', quantity: 1 }, null));
    expect(e).toMatchObject({ code: 'INVALID_REASON' });
    expect((e!.details as { allowed: string[] }).allowed).toContain('VENDA');
    expect((e!.details as { allowed: string[] }).allowed).not.toContain('COMPRA');
  });

  it('ESTORNO não pode ser escolhido como motivo numa movimentação comum', async () => {
    const { service } = setup();
    for (const type of ['ENTRADA', 'SAIDA'] as const) {
      const e = await failure(service.create(manager, { productId: PID, type, reason: 'ESTORNO', quantity: 1 }, null));
      expect(e).toMatchObject({ code: 'INVALID_REASON' });
    }
  });

  it('motivo omitido vira OUTRO', async () => {
    const { service, clientCalls } = setup();
    await service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 2 }, null);
    const insert = clientCalls.find((c) => /INSERT INTO stock_movements/.test(c.sql))!;
    expect(insert.params[2]).toBe('OUTRO');
  });

  it.each([
    ['nenhum identificador', {}],
    ['dois identificadores', { productId: PID, sku: 'A' }],
    ['três identificadores', { productId: PID, sku: 'A', barcode: '7891000100103' }],
  ])('exige exatamente um identificador de produto: %s -> 400', async (_n, ids) => {
    const { service } = setup();
    const e = await failure(service.create(clerk, { ...ids, type: 'ENTRADA', quantity: 1 } as any, null));
    expect(e).toMatchObject({ code: 'PRODUCT_IDENTIFIER_REQUIRED' });
  });

  it.each([
    ['productId', { productId: PID }, 'id'],
    ['barcode', { barcode: '7891000100103' }, 'barcode'],
    ['sku', { sku: 'CAFE-500' }, 'sku'],
  ])('resolve o produto por %s usando coluna fixa (sem interpolar entrada do usuário)', async (_n, ids, column) => {
    const { service, db } = setup();
    await service.create(clerk, { ...ids, type: 'ENTRADA', quantity: 1 } as any, null);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toBe(`SELECT id FROM products WHERE ${column} = $1`);
    expect(params).toEqual([Object.values(ids)[0]]);
  });

  it('produto inexistente -> 404 PRODUCT_NOT_FOUND', async () => {
    const { service } = setup({ productRows: [] });
    const e = await failure(service.create(clerk, { sku: 'NAO', type: 'ENTRADA', quantity: 1 }, null));
    expect(e).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    expect(e!.getStatus()).toBe(404);
  });

  it('grava na transação com o usuário autenticado e devolve a movimentação formatada', async () => {
    const { service, db, clientCalls } = setup();
    const r = await service.create(manager, { productId: PID, type: 'ENTRADA', reason: 'COMPRA', quantity: 5, unitCost: 9.5, documentRef: 'NF-1' }, KEY);
    expect(db.tx).toHaveBeenCalledWith('m1', expect.any(Function)); // app.current_user_id para a auditoria
    expect(clientCalls[0].params).toEqual([PID, 'ENTRADA', 'COMPRA', 5, 9.5, null, 'NF-1', null, KEY, 'm1']);
    expect(r.replayed).toBe(false);
    expect(r.movement).toMatchObject({ id: 7, productName: 'Produto A', quantity: 5 });
    expect(r.movement).toHaveProperty('unitCost'); // Gerente
  });

  it('resposta ao Estoquista não contém unitCost', async () => {
    const { service } = setup();
    const r = await service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 5 }, null);
    expect(r.movement).not.toHaveProperty('unitCost');
  });
});

describe('StockService: idempotência (reenvio após falha de rede)', () => {
  const duplicateKey = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'stock_movements_idempotency_key_key' });

  function withDuplicate(existingUserId: string | null) {
    const ctx = setup();
    ctx.db.tx.mockRejectedValue(duplicateKey());
    ctx.db.query.mockImplementation(async (sql: string) => {
      if (/FROM products WHERE/.test(sql)) return { rows: [{ id: PID }] };
      if (/idempotency_key = \$1/.test(sql)) return { rows: existingUserId ? [kardexRow({ user_id: existingUserId })] : [] };
      return { rows: [] };
    });
    return ctx;
  }

  it('mesma chave e mesmo usuário: devolve a movimentação original (replayed)', async () => {
    const { service } = withDuplicate('c1');
    const r = await service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 5 }, KEY);
    expect(r.replayed).toBe(true);
    expect(r.movement.id).toBe(7);
  });

  it('mesma chave de OUTRO usuário -> 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const { service } = withDuplicate('outro');
    const e = await failure(service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 5 }, KEY));
    expect(e).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(e!.getStatus()).toBe(409);
  });

  it('violação de unicidade SEM chave de idempotência não é engolida', async () => {
    const { service } = withDuplicate('c1');
    const e = await failure(service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 5 }, null));
    expect((e as any).code).toBe('23505');
  });

  it('violação de OUTRA constraint única não é tratada como reenvio', async () => {
    const { service, db } = setup();
    db.tx.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505', constraint: 'stock_movements_reversal_of_id_key' }));
    const e = await failure(service.create(clerk, { productId: PID, type: 'ENTRADA', quantity: 5 }, KEY));
    expect((e as any).constraint).toBe('stock_movements_reversal_of_id_key');
  });

  it('erros do banco (ex.: saldo insuficiente) sobem intactos para o filtro de erros', async () => {
    const { service, db } = setup();
    const pg = Object.assign(new Error('ST001: estoque insuficiente'), { code: 'ST001' });
    db.tx.mockRejectedValue(pg);
    expect(await failure(service.create(clerk, { productId: PID, type: 'SAIDA', quantity: 99 }, null))).toBe(pg);
  });
});

describe('StockService.reverse: reenvio quando o PostgreSQL acusa a unicidade do estorno', () => {
  const reversalDup = () => Object.assign(new Error('dup'), { code: '23505', constraint: 'stock_movements_reversal_of_id_key' });

  it('mesma chave + mesmo usuário: é reenvio, devolve o estorno já feito (200 no controller)', async () => {
    const ctx = setup();
    ctx.db.tx.mockRejectedValue(reversalDup());
    ctx.db.query.mockResolvedValue({ rows: [kardexRow({ id: '8', user_id: 'm1', reason: 'ESTORNO', reversal_of_id: '7' })] });
    const r = await ctx.service.reverse(manager, 7, {}, KEY);
    expect(r.replayed).toBe(true);
  });

  it('chave inédita (outra tentativa de estornar a mesma movimentação): segue como erro de duplicidade', async () => {
    const ctx = setup();
    const dup = reversalDup();
    ctx.db.tx.mockRejectedValue(dup);
    ctx.db.query.mockResolvedValue({ rows: [] }); // nenhuma movimentação com esta chave
    expect(await failure(ctx.service.reverse(manager, 7, {}, KEY))).toBe(dup);
  });

  it('sem chave: erro de duplicidade sobe normalmente (409 DUPLICATE)', async () => {
    const ctx = setup();
    const dup = reversalDup();
    ctx.db.tx.mockRejectedValue(dup);
    expect(await failure(ctx.service.reverse(manager, 7, {}, null))).toBe(dup);
    expect(ctx.db.query).not.toHaveBeenCalled();
  });

  it('a chave pertence a outro usuário: 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const ctx = setup();
    ctx.db.tx.mockRejectedValue(reversalDup());
    ctx.db.query.mockResolvedValue({ rows: [kardexRow({ user_id: 'outro' })] });
    expect(await failure(ctx.service.reverse(manager, 7, {}, KEY))).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });
});

describe('StockService.reverse', () => {
  const original = { rows: [{ product_id: PID, type: 'ENTRADA', quantity: '5.000' }] };

  it('cria a movimentação INVERSA da original, com ESTORNO e reversal_of_id', async () => {
    const { service, clientCalls } = setup({
      client: (sql) => {
        if (/FROM stock_movements WHERE id/.test(sql)) return original;
        if (/INSERT INTO stock_movements/.test(sql)) return { rows: [{ id: '8' }] };
        return { rows: [kardexRow({ id: '8', type: 'SAIDA', reason: 'ESTORNO', reversal_of_id: '7' })] };
      },
    });
    const r = await service.reverse(manager, 7, { notes: 'duplicado' }, KEY);
    const insert = clientCalls.find((c) => /INSERT INTO stock_movements/.test(c.sql))!;
    expect(insert.sql).toContain(`'ESTORNO'`);
    expect(insert.params).toEqual([PID, 'SAIDA', '5.000', 7, 'duplicado', KEY, 'm1']); // tipo oposto
    expect(r.movement).toMatchObject({ id: 8, reversalOfId: 7, reason: 'ESTORNO' });
  });

  it('estorno de SAÍDA gera ENTRADA', async () => {
    const { service, clientCalls } = setup({
      client: (sql) => {
        if (/FROM stock_movements WHERE id/.test(sql)) return { rows: [{ product_id: PID, type: 'SAIDA', quantity: '2.500' }] };
        if (/INSERT INTO stock_movements/.test(sql)) return { rows: [{ id: '9' }] };
        return { rows: [kardexRow({ id: '9' })] };
      },
    });
    await service.reverse(manager, 3, {}, null);
    const insert = clientCalls.find((c) => /INSERT INTO stock_movements/.test(c.sql))!;
    expect(insert.params[1]).toBe('ENTRADA');
    expect(insert.params[2]).toBe('2.500');
  });

  it('movimentação original inexistente -> 404 MOVEMENT_NOT_FOUND', async () => {
    const { service } = setup({ client: () => ({ rows: [] }) });
    const e = await failure(service.reverse(manager, 999, {}, null));
    expect(e).toMatchObject({ code: 'MOVEMENT_NOT_FOUND' });
    expect(e!.getStatus()).toBe(404);
  });

  it('reenvio do mesmo estorno (mesma chave) devolve o estorno já feito', async () => {
    const ctx = setup();
    ctx.db.tx.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505', constraint: 'stock_movements_idempotency_key_key' }));
    ctx.db.query.mockResolvedValue({ rows: [kardexRow({ id: '8', user_id: 'm1', reason: 'ESTORNO', reversal_of_id: '7' })] });
    const r = await ctx.service.reverse(manager, 7, {}, KEY);
    expect(r.replayed).toBe(true);
    expect(r.movement.id).toBe(8);
  });
});
