/**
 * Integração: API HTTP completa (NestJS + guardas + filtro de erros + PostgreSQL real) via Supertest.
 * Cobre entrada, saída, estorno, saldos, alertas, Kardex, RBAC e erros padronizados.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { bearer, createTestApp, loginAs, TestApp } from '../helpers/app';
import { createProduct, createTestDb, createUser, SeedProduct, SeedUser, stockOf, TestDb } from '../helpers/db';

let db: TestDb;
let pool: Pool;
let t: TestApp;
let manager: SeedUser;
let clerk: SeedUser;
let M: string; // token do gerente
let E: string; // token do estoquista

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  t = await createTestApp(db.url);
  manager = await createUser(pool, { role: 'GERENTE', name: 'Maria Gerente' });
  clerk = await createUser(pool, { role: 'ESTOQUISTA', name: 'Ana Estoquista' });
  M = (await loginAs(t, manager.email, manager.password)).accessToken;
  E = (await loginAs(t, clerk.email, clerk.password)).accessToken;
});
afterAll(async () => {
  await t.close();
  await db.drop();
});

const post = (token: string, body: object, headers: Record<string, string> = {}) =>
  t.http.post('/api/stock/movements').set(bearer(token)).set(headers).send(body);

const newProduct = (opts: Parameters<typeof createProduct>[1] = {}) => createProduct(pool, opts);

/** Dá saldo inicial a um produto pela própria API (ENTRADA). */
async function seedStock(p: SeedProduct, qty: number) {
  const r = await post(E, { productId: p.id, type: 'ENTRADA', reason: 'COMPRA', quantity: qty });
  expect(r.status).toBe(201);
}

describe('POST /api/stock/movements: ENTRADA', () => {
  it('registra a entrada, devolve 201 e atualiza o saldo em tempo real', async () => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, type: 'ENTRADA', reason: 'COMPRA', quantity: 100, documentRef: 'NF-123', notes: 'lote 1' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      type: 'ENTRADA',
      reason: 'COMPRA',
      quantity: 100,
      signedQuantity: 100,
      balanceBefore: 0,
      balanceAfter: 100,
      documentRef: 'NF-123',
      notes: 'lote 1',
      userName: 'Ana Estoquista',
      reversalOfId: null,
      reversedById: null,
    });
    expect(typeof r.body.data.id).toBe('number');
    expect(Date.now() - Date.parse(r.body.data.createdAt)).toBeLessThan(60_000);
    expect(await stockOf(pool, p.id)).toBe('100.000');
  });

  it('a entrada seguinte soma ao saldo existente', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 2.5 });
    expect(r.body.data).toMatchObject({ balanceBefore: 10, balanceAfter: 12.5 });
  });

  it('identifica o produto por código de barras (leitor) ou por SKU', async () => {
    const p = await newProduct({ barcode: '7891000100103', sku: 'CAFE-500' });
    const byBarcode = await post(E, { barcode: '7891000100103', type: 'ENTRADA', quantity: 5 });
    const bySku = await post(E, { sku: 'cafe-500', type: 'ENTRADA', quantity: 5 }); // SKU não diferencia maiúsculas
    expect(byBarcode.status).toBe(201);
    expect(bySku.status).toBe(201);
    expect(bySku.body.data.balanceAfter).toBe(10);
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('Gerente informa custo unitário e fornecedor; o custo volta só para ele', async () => {
    const p = await newProduct();
    const { rows } = await pool.query(`INSERT INTO suppliers (name) VALUES ('Distribuidora Sul') RETURNING id`);
    const r = await post(M, { productId: p.id, type: 'ENTRADA', reason: 'COMPRA', quantity: 5, unitCost: 9.5, supplierId: rows[0].id });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ unitCost: 9.5, supplierName: 'Distribuidora Sul' });
  });

  it('motivo omitido vira OUTRO', async () => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1 });
    expect(r.body.data.reason).toBe('OUTRO');
  });
});

describe('POST /api/stock/movements: SAÍDA', () => {
  it('registra a saída e subtrai do saldo', async () => {
    const p = await newProduct();
    await seedStock(p, 20);
    const r = await post(E, { productId: p.id, type: 'SAIDA', reason: 'VENDA', quantity: 8 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ type: 'SAIDA', signedQuantity: -8, balanceBefore: 20, balanceAfter: 12 });
    expect(await stockOf(pool, p.id)).toBe('12.000');
  });

  it('saída exatamente igual ao saldo é aceita e zera o estoque', async () => {
    const p = await newProduct();
    await seedStock(p, 5);
    const r = await post(E, { productId: p.id, type: 'SAIDA', quantity: 5 });
    expect(r.status).toBe(201);
    expect(r.body.data.balanceAfter).toBe(0);
  });

  it('saldo insuficiente -> 422 INSUFFICIENT_STOCK, com a mensagem do banco, e o saldo não muda', async () => {
    const p = await newProduct();
    await seedStock(p, 3);
    const r = await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(r.body.error.message).toMatch(/saldo 3\.000, solicitado 4\.000/);
    expect(await stockOf(pool, p.id)).toBe('3.000');
  });

  it('saída em produto sem estoque algum -> 422', async () => {
    const p = await newProduct();
    expect((await post(E, { productId: p.id, type: 'SAIDA', quantity: 1 })).status).toBe(422);
  });

  it('quantidades fracionárias (KG) não acumulam erro de arredondamento', async () => {
    const p = await newProduct({ unit: 'KG' });
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 0.1 });
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 0.2 });
    const r = await post(E, { productId: p.id, type: 'SAIDA', quantity: 0.3 });
    expect(r.status).toBe(201);
    expect(r.body.data.balanceAfter).toBe(0);
  });

  it('motivo de entrada numa saída (e vice-versa) -> 400 INVALID_REASON', async () => {
    const p = await newProduct();
    await seedStock(p, 5);
    const r = await post(E, { productId: p.id, type: 'SAIDA', reason: 'COMPRA', quantity: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REASON');
    expect(r.body.error.details.allowed).toContain('VENDA');
    expect((await post(E, { productId: p.id, type: 'ENTRADA', reason: 'VENDA', quantity: 1 })).status).toBe(400);
  });
});

describe('POST /api/stock/movements: validação e erros padronizados', () => {
  it('todo erro segue o envelope { error: { code, message, requestId, timestamp } }', async () => {
    const r = await post(E, { type: 'ENTRADA', quantity: 1 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: expect.objectContaining({ code: expect.any(String), message: expect.any(String), requestId: expect.any(String), timestamp: expect.any(String) }) });
    expect(r.headers['x-request-id']).toBe(r.body.error.requestId);
  });

  it('respeita o X-Request-Id enviado pelo cliente (rastreio ponta a ponta)', async () => {
    const r = await t.http.get('/api/stock/balances').set(bearer(E)).set('X-Request-Id', 'front-req-12345678');
    expect(r.headers['x-request-id']).toBe('front-req-12345678');
  });

  it.each([
    ['quantidade zero', { quantity: 0 }],
    ['quantidade negativa', { quantity: -5 }],
    ['quantidade como texto', { quantity: '5' }],
    ['4 casas decimais', { quantity: 1.2345 }],
    ['tipo inválido', { type: 'TRANSFERENCIA' }],
    ['campo desconhecido (tentativa de gravar o saldo)', { currentStock: 99999 }],
    ['campo desconhecido (tentativa de escolher o usuário)', { userId: '00000000-0000-0000-0000-000000000000' }],
  ])('%s -> 400 VALIDATION_ERROR com detalhes por campo', async (_n, patch) => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1, ...patch });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: expect.any(String), messages: expect.any(Array) })]));
  });

  it('sem identificador do produto -> 400 PRODUCT_IDENTIFIER_REQUIRED', async () => {
    const r = await post(E, { type: 'ENTRADA', quantity: 1 });
    expect(r.body.error.code).toBe('PRODUCT_IDENTIFIER_REQUIRED');
  });

  it('dois identificadores ao mesmo tempo -> 400 (evita ambiguidade)', async () => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, sku: p.sku, type: 'ENTRADA', quantity: 1 });
    expect(r.body.error.code).toBe('PRODUCT_IDENTIFIER_REQUIRED');
  });

  it('produto inexistente -> 404 PRODUCT_NOT_FOUND', async () => {
    const r = await post(E, { sku: 'NAO-EXISTE', type: 'ENTRADA', quantity: 1 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('PRODUCT_NOT_FOUND');
    expect((await post(E, { barcode: '9999999999999', type: 'ENTRADA', quantity: 1 })).status).toBe(404);
  });

  it('produto inativo -> 422 PRODUCT_UNAVAILABLE', async () => {
    const p = await newProduct({ active: false });
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('fornecedor inexistente -> 422 REFERENCE_NOT_FOUND (e a entrada não é gravada)', async () => {
    const p = await newProduct();
    const r = await post(M, { productId: p.id, type: 'ENTRADA', quantity: 5, supplierId: randomUUID() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('REFERENCE_NOT_FOUND');
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('JSON malformado -> 400 INVALID_JSON', async () => {
    const r = await t.http.post('/api/stock/movements').set(bearer(E)).set('Content-Type', 'application/json').send('{"quantity": ');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_JSON');
  });

  it('corpo acima de 100 kB -> 413 PAYLOAD_TOO_LARGE', async () => {
    const r = await post(E, { type: 'ENTRADA', quantity: 1, notes: 'x'.repeat(150_000) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rota inexistente -> 404 NOT_FOUND padronizado; método não suportado também', async () => {
    const r = await t.http.get('/api/nao-existe').set(bearer(E));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
    expect((await t.http.delete('/api/stock/movements/1').set(bearer(E))).status).toBe(404);
  });
});

describe('Idempotency-Key (reenvio seguro após falha de rede)', () => {
  it('reenviar com a mesma chave NÃO duplica: 201 na primeira, 200 + Idempotent-Replayed no reenvio', async () => {
    const p = await newProduct();
    await seedStock(p, 50);
    const key = randomUUID();
    const body = { productId: p.id, type: 'SAIDA', reason: 'VENDA', quantity: 7 };
    const first = await post(E, body, { 'Idempotency-Key': key });
    const second = await post(E, body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await stockOf(pool, p.id)).toBe('43.000'); // uma saída só
  });

  it('chaves diferentes são operações diferentes', async () => {
    const p = await newProduct();
    await seedStock(p, 50);
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 5 }, { 'Idempotency-Key': randomUUID() });
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 5 }, { 'Idempotency-Key': randomUUID() });
    expect(await stockOf(pool, p.id)).toBe('40.000');
  });

  it('chave já usada por OUTRO usuário -> 409 IDEMPOTENCY_KEY_CONFLICT (sem vazar a movimentação alheia)', async () => {
    const p = await newProduct();
    await seedStock(p, 50);
    const key = randomUUID();
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 1 }, { 'Idempotency-Key': key });
    const r = await post(M, { productId: p.id, type: 'SAIDA', quantity: 1 }, { 'Idempotency-Key': key });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(JSON.stringify(r.body)).not.toContain('Ana Estoquista');
  });

  it('chave que não é UUID -> 400 INVALID_IDEMPOTENCY_KEY', async () => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1 }, { 'Idempotency-Key': 'abc' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('10 reenvios simultâneos com a mesma chave resultam em UMA movimentação', async () => {
    const p = await newProduct();
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => post(E, { productId: p.id, type: 'ENTRADA', quantity: 4 }, { 'Idempotency-Key': key })));
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
    expect(await stockOf(pool, p.id)).toBe('4.000');
  });
});

describe('concorrência pela API', () => {
  it('30 saídas simultâneas de 4 sobre saldo 100: 25 passam, 5 recusadas, saldo exato 0', async () => {
    const p = await newProduct();
    await seedStock(p, 100);
    const rs = await Promise.all(Array.from({ length: 30 }, () => post(E, { productId: p.id, type: 'SAIDA', reason: 'VENDA', quantity: 4 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(25);
    expect(rs.filter((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_STOCK')).toHaveLength(5);
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });
});

describe('estorno: POST /api/stock/movements/:id/reversal', () => {
  const reverse = (token: string, id: number | string, body: object = {}, headers: Record<string, string> = {}) =>
    t.http.post(`/api/stock/movements/${id}/reversal`).set(bearer(token)).set(headers).send(body);

  it('Gerente estorna uma saída: cria ENTRADA inversa, aponta para a original e devolve o saldo', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    const r = await reverse(M, out.id, { notes: 'lançado por engano' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      type: 'ENTRADA',
      reason: 'ESTORNO',
      quantity: 4,
      reversalOfId: out.id,
      balanceBefore: 6,
      balanceAfter: 10,
      notes: 'lançado por engano',
      userName: 'Maria Gerente', // quem estornou fica registrado
    });
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('a movimentação original NÃO é apagada nem alterada: aparece no Kardex como estornada', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    const rev = (await reverse(M, out.id)).body.data;
    const k = await t.http.get('/api/stock/kardex').query({ productId: p.id }).set(bearer(M));
    const row = k.body.data.find((m: any) => m.id === out.id);
    expect(row).toMatchObject({ quantity: 4, type: 'SAIDA', reversedById: rev.id });
    expect(k.body.data).toHaveLength(3);
  });

  it('Estoquista não pode estornar -> 403 FORBIDDEN, e nada muda', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    const r = await reverse(E, out.id);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    expect(await stockOf(pool, p.id)).toBe('6.000');
  });

  it('estornar duas vezes a mesma movimentação -> 409 DUPLICATE', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    expect((await reverse(M, out.id)).status).toBe(201);
    const again = await reverse(M, out.id);
    expect(again.status).toBe(409);
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('estornar um estorno -> 422 INVALID_REVERSAL', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    const rev = (await reverse(M, out.id)).body.data;
    const r = await reverse(M, rev.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_REVERSAL');
  });

  it('estornar entrada já consumida -> 422 INSUFFICIENT_STOCK (estoque nunca fica negativo)', async () => {
    const p = await newProduct();
    const entrada = (await post(E, { productId: p.id, type: 'ENTRADA', quantity: 10 })).body.data;
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 8 });
    const r = await reverse(M, entrada.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(pool, p.id)).toBe('2.000');
  });

  it('movimentação inexistente -> 404 MOVEMENT_NOT_FOUND; id inválido -> 400', async () => {
    const r = await reverse(M, 999_999);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('MOVEMENT_NOT_FOUND');
    expect((await reverse(M, 'abc')).status).toBe(400);
  });

  it('estorno com Idempotency-Key é idempotente', async () => {
    const p = await newProduct();
    await seedStock(p, 10);
    const out = (await post(E, { productId: p.id, type: 'SAIDA', quantity: 4 })).body.data;
    const key = randomUUID();
    const a = await reverse(M, out.id, {}, { 'Idempotency-Key': key });
    const b = await reverse(M, out.id, {}, { 'Idempotency-Key': key });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('não existe rota para apagar ou editar movimentações (nada é apagado, só estornado)', async () => {
    const p = await newProduct();
    await seedStock(p, 1);
    const id = (await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1 })).body.data.id;
    for (const method of ['delete', 'put', 'patch'] as const) {
      const r = await (t.http as any)[method](`/api/stock/movements/${id}`).set(bearer(M)).send({});
      expect(r.status).toBe(404);
    }
    const { rowCount } = await pool.query(`SELECT 1 FROM stock_movements WHERE id = $1`, [id]);
    expect(rowCount).toBe(1);
  });
});

describe('RBAC: o que cada perfil enxerga', () => {
  it('Estoquista registra e consulta saldos, mas não vê nenhum campo de custo', async () => {
    const p = await newProduct({ costPrice: 77.77 });
    await post(M, { productId: p.id, type: 'ENTRADA', quantity: 5, unitCost: 8.88 });

    const balances = await t.http.get('/api/stock/balances').query({ sku: p.sku }).set(bearer(E));
    const kardex = await t.http.get('/api/stock/kardex').query({ productId: p.id }).set(bearer(E));
    const movements = await t.http.get('/api/stock/movements').query({ productId: p.id }).set(bearer(E));
    const alerts = await t.http.get('/api/stock/alerts').set(bearer(E));

    for (const r of [balances, kardex, movements, alerts]) {
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toMatch(/unitCost|costPrice|cost_price|unit_cost/);
      expect(text).not.toContain('77.77');
      expect(text).not.toContain('8.88');
    }
  });

  it('Gerente vê o custo unitário no Kardex e nas movimentações', async () => {
    const p = await newProduct();
    await post(M, { productId: p.id, type: 'ENTRADA', quantity: 5, unitCost: 8.88 });
    const kardex = await t.http.get('/api/stock/kardex').query({ productId: p.id }).set(bearer(M));
    expect(kardex.body.data[0].unitCost).toBe(8.88);
    const mv = await t.http.get('/api/stock/movements').query({ productId: p.id }).set(bearer(M));
    expect(mv.body.data[0].unitCost).toBe(8.88);
  });

  it('Estoquista enviando unitCost -> 403 FORBIDDEN_FIELD e nada é gravado', async () => {
    const p = await newProduct();
    const r = await post(E, { productId: p.id, type: 'ENTRADA', quantity: 5, unitCost: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN_FIELD');
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('custo em saída é recusado até para o Gerente (400)', async () => {
    const p = await newProduct();
    await seedStock(p, 5);
    const r = await post(M, { productId: p.id, type: 'SAIDA', quantity: 1, unitCost: 3 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_FIELD');
  });
});

describe('consultas: saldos, alertas, movimentações e Kardex', () => {
  let cafe: SeedProduct;
  let arroz: SeedProduct;
  let feijao: SeedProduct;

  beforeAll(async () => {
    cafe = await newProduct({ sku: 'Q-CAFE', barcode: '7897000100101', name: 'Café Torrado 500g', safetyStock: 20 });
    arroz = await newProduct({ sku: 'Q-ARROZ', barcode: '7897000200202', name: 'Arroz 5kg', safetyStock: 10 });
    feijao = await newProduct({ sku: 'Q-FEIJAO', barcode: '7897000300303', name: 'Feijão Carioca 1kg', safetyStock: 15 });
    await seedStock(cafe, 12); // BAIXO (12 <= 20)
    await seedStock(feijao, 100); // OK
    // arroz: sem movimentação -> ZERADO
  });

  it('GET /balances por código de barras (busca exata do leitor)', async () => {
    const r = await t.http.get('/api/stock/balances').query({ barcode: '7897000100101' }).set(bearer(E));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([{ id: cafe.id, sku: 'Q-CAFE', barcode: '7897000100101', name: 'Café Torrado 500g', unit: 'UN', currentStock: 12, safetyStock: 20, status: 'BAIXO' }]);
  });

  it.each([
    ['nome parcial, sem acento de caixa', { q: 'torrado' }, ['Q-CAFE']],
    ['SKU parcial', { q: 'q-arr' }, ['Q-ARROZ']],
    ['código de barras parcial', { q: '78970003' }, ['Q-FEIJAO']],
    ['situação ZERADO', { q: 'Q-', status: 'ZERADO' }, ['Q-ARROZ']],
    ['situação BAIXO', { q: 'Q-', status: 'BAIXO' }, ['Q-CAFE']],
    ['situação OK', { q: 'Q-', status: 'OK' }, ['Q-FEIJAO']],
    ['SKU exato', { sku: 'Q-ARROZ' }, ['Q-ARROZ']],
  ])('GET /balances: %s', async (_n, query, skus) => {
    const r = await t.http.get('/api/stock/balances').query(query).set(bearer(E));
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.sku).sort()).toEqual([...skus].sort());
  });

  it('GET /balances: caracteres curinga da busca (% e _) são tratados como texto, não como padrão', async () => {
    const r = await t.http.get('/api/stock/balances').query({ q: '%' }).set(bearer(E));
    expect(r.body.data).toEqual([]);
    expect((await t.http.get('/api/stock/balances').query({ q: "'; DROP TABLE products;--" }).set(bearer(E))).body.data).toEqual([]);
    expect(await stockOf(pool, cafe.id)).toBe('12.000'); // a tabela segue de pé
  });

  it('GET /balances: paginação', async () => {
    const p1 = await t.http.get('/api/stock/balances').query({ q: 'Q-', limit: 2, offset: 0 }).set(bearer(E));
    const p2 = await t.http.get('/api/stock/balances').query({ q: 'Q-', limit: 2, offset: 2 }).set(bearer(E));
    expect(p1.body).toMatchObject({ limit: 2, offset: 0 });
    expect(p1.body.data).toHaveLength(2);
    expect(p2.body.data).toHaveLength(1);
    expect(p1.body.data.map((x: any) => x.id)).not.toContain(p2.body.data[0].id);
  });

  it.each([
    ['limit acima do máximo', { limit: 201 }],
    ['limit zero', { limit: 0 }],
    ['offset negativo', { offset: -1 }],
    ['barcode inválido', { barcode: 'abc' }],
    ['situação inválida', { status: 'MEIO' }],
    ['parâmetro desconhecido', { foo: 'bar' }],
  ])('GET /balances: %s -> 400', async (_n, query) => {
    const r = await t.http.get('/api/stock/balances').query(query).set(bearer(E));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /alerts: itens críticos, zerados primeiro, com falta e resumo', async () => {
    const r = await t.http.get('/api/stock/alerts').set(bearer(E));
    expect(r.status).toBe(200);
    const mine = r.body.data.filter((x: any) => x.sku.startsWith('Q-'));
    expect(mine.map((x: any) => [x.sku, x.status, x.shortfall])).toEqual([
      ['Q-ARROZ', 'ZERADO', 10],
      ['Q-CAFE', 'BAIXO', 8],
    ]);
    expect(r.body.summary.total).toBe(r.body.data.length);
    expect(r.body.summary.zerado + r.body.summary.baixo).toBe(r.body.summary.total);
    expect(r.body.data.map((x: any) => x.sku)).not.toContain('Q-FEIJAO');
  });

  it('o alerta some assim que a reposição leva o saldo acima do mínimo, em tempo real', async () => {
    const p = await newProduct({ sku: 'Q-REPOR', safetyStock: 10 });
    const has = async () => (await t.http.get('/api/stock/alerts').set(bearer(E))).body.data.some((x: any) => x.sku === 'Q-REPOR');
    expect(await has()).toBe(true); // zerado
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 11 });
    expect(await has()).toBe(false);
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 5 });
    expect(await has()).toBe(true); // 6 <= 10
  });

  it('GET /kardex: extrato cronológico com saldo corrente encadeado', async () => {
    const p = await newProduct();
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 50 });
    await post(E, { productId: p.id, type: 'SAIDA', quantity: 12 });
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 7 });
    const r = await t.http.get('/api/stock/kardex').query({ productId: p.id }).set(bearer(E));
    expect(r.body.data.map((m: any) => [m.type, m.balanceBefore, m.balanceAfter])).toEqual([
      ['ENTRADA', 0, 50],
      ['SAIDA', 50, 38],
      ['ENTRADA', 38, 45],
    ]);
  });

  it('GET /kardex: filtro por período', async () => {
    const p = await newProduct();
    await post(E, { productId: p.id, type: 'ENTRADA', quantity: 1 });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const none = await t.http.get('/api/stock/kardex').query({ productId: p.id, from: future }).set(bearer(E));
    const all = await t.http.get('/api/stock/kardex').query({ productId: p.id, from: past, to: future }).set(bearer(E));
    expect(none.body.data).toHaveLength(0);
    expect(all.body.data).toHaveLength(1);
  });

  it('GET /kardex exige productId; datas inválidas -> 400', async () => {
    expect((await t.http.get('/api/stock/kardex').set(bearer(E))).status).toBe(400);
    expect((await t.http.get('/api/stock/kardex').query({ productId: cafe.id, from: 'ontem' }).set(bearer(E))).status).toBe(400);
  });

  it('GET /movements: mais recentes primeiro, com filtros por produto e tipo', async () => {
    const r = await t.http.get('/api/stock/movements').query({ productId: cafe.id, type: 'ENTRADA' }).set(bearer(E));
    expect(r.status).toBe(200);
    expect(r.body.data.every((m: any) => m.productId === cafe.id && m.type === 'ENTRADA')).toBe(true);
    const all = (await t.http.get('/api/stock/movements').query({ limit: 200 }).set(bearer(E))).body.data;
    const times = all.map((m: any) => Date.parse(m.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('toda movimentação traz data/hora, tipo e usuário (auditoria)', async () => {
    const r = await t.http.get('/api/stock/movements').query({ limit: 5 }).set(bearer(M));
    for (const m of r.body.data) {
      expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
      expect(['ENTRADA', 'SAIDA']).toContain(m.type);
      expect(typeof m.userName).toBe('string');
      expect(m.userName.length).toBeGreaterThan(0);
    }
  });

  it('valores numéricos chegam como número (não string) para o frontend', async () => {
    const r = await t.http.get('/api/stock/balances').query({ sku: 'Q-CAFE' }).set(bearer(E));
    expect(typeof r.body.data[0].currentStock).toBe('number');
    expect(typeof r.body.data[0].safetyStock).toBe('number');
  });
});
