/**
 * Testes unitários do CÁLCULO DE SALDO.
 * A regra vive no trigger fn_apply_stock_movement (PostgreSQL), então é exercitada contra um banco real
 * (um banco descartável por arquivo de teste, clonado do schema.sql).
 */
import { Pool } from 'pg';
import { createProduct, createTestDb, createUser, insertMovement, pgError, stockOf, TestDb } from '../helpers/db';

let db: TestDb;
let pool: Pool;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  userId = (await createUser(pool)).id;
});
afterAll(() => db.drop());

const mov = (productId: string, type: 'ENTRADA' | 'SAIDA', quantity: number | string, extra: object = {}) =>
  insertMovement(pool, { productId, userId, type, quantity, ...extra });

describe('saldo: entradas e saídas', () => {
  it('produto novo começa com saldo zero', async () => {
    const p = await createProduct(pool);
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('entrada soma ao saldo e registra saldo anterior e posterior', async () => {
    const p = await createProduct(pool);
    const m = await mov(p.id, 'ENTRADA', 10);
    expect(m.balance_before).toBe('0.000');
    expect(m.balance_after).toBe('10.000');
    expect(m.signed_quantity).toBe('10.000');
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('saída subtrai do saldo e guarda a quantidade com sinal negativo', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 10);
    const m = await mov(p.id, 'SAIDA', 3);
    expect(m.balance_before).toBe('10.000');
    expect(m.balance_after).toBe('7.000');
    expect(m.signed_quantity).toBe('-3.000');
    expect(await stockOf(pool, p.id)).toBe('7.000');
  });

  it('saída exatamente igual ao saldo zera o estoque (limite permitido)', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    await mov(p.id, 'SAIDA', 5);
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('saída acima do saldo é recusada (ST001), sem alterar o saldo nem gravar a movimentação', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    const e = await pgError(mov(p.id, 'SAIDA', 5.001));
    expect(e?.code).toBe('ST001');
    expect(e?.message).toMatch(/estoque insuficiente/);
    expect(await stockOf(pool, p.id)).toBe('5.000');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1`, [p.id]);
    expect(rows[0].n).toBe(1);
  });

  it('saída em produto sem estoque é recusada', async () => {
    const p = await createProduct(pool);
    expect((await pgError(mov(p.id, 'SAIDA', 1)))?.code).toBe('ST001');
  });

  it('suporta 3 casas decimais sem erro de ponto flutuante (0,1 + 0,2 = 0,3)', async () => {
    const p = await createProduct(pool, { unit: 'KG' });
    await mov(p.id, 'ENTRADA', '0.1');
    await mov(p.id, 'ENTRADA', '0.2');
    expect(await stockOf(pool, p.id)).toBe('0.300');
    await mov(p.id, 'SAIDA', '0.300');
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('quantidade fracionária pequena (0,001) funciona nos dois sentidos', async () => {
    const p = await createProduct(pool, { unit: 'KG' });
    await mov(p.id, 'ENTRADA', '0.001');
    await mov(p.id, 'SAIDA', '0.001');
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('o saldo de um produto não afeta o de outro', async () => {
    const a = await createProduct(pool);
    const b = await createProduct(pool);
    await mov(a.id, 'ENTRADA', 10);
    await mov(b.id, 'ENTRADA', 3);
    await mov(a.id, 'SAIDA', 4);
    expect(await stockOf(pool, a.id)).toBe('6.000');
    expect(await stockOf(pool, b.id)).toBe('3.000');
  });
});

describe('saldo: validações no banco', () => {
  it.each([0, -1])('quantidade %s é recusada (CHECK quantity > 0)', async (q) => {
    const p = await createProduct(pool);
    expect((await pgError(mov(p.id, 'ENTRADA', q)))?.code).toBe('23514');
  });

  it('produto inexistente é recusado (ST004 ou chave estrangeira)', async () => {
    const e = await pgError(mov('00000000-0000-0000-0000-000000000000', 'ENTRADA', 1));
    expect(['ST004', '23503']).toContain(e?.code);
  });

  it('produto INATIVO não aceita movimentação (ST004)', async () => {
    const p = await createProduct(pool, { active: false });
    expect((await pgError(mov(p.id, 'ENTRADA', 1)))?.code).toBe('ST004');
  });

  it('a data/hora é definida pelo banco: valor retroativo enviado pela aplicação é ignorado', async () => {
    const p = await createProduct(pool);
    const { rows } = await pool.query(
      `INSERT INTO stock_movements (product_id, user_id, type, quantity, created_at)
       VALUES ($1, $2, 'ENTRADA', 1, '2020-01-01') RETURNING created_at`,
      [p.id, userId],
    );
    expect(new Date(rows[0].created_at).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('saldos informados pela aplicação (balance_before/after) são sobrescritos pelo cálculo do banco', async () => {
    const p = await createProduct(pool);
    const { rows } = await pool.query(
      `INSERT INTO stock_movements (product_id, user_id, type, quantity, balance_before, balance_after)
       VALUES ($1, $2, 'ENTRADA', 4, 100, 104) RETURNING balance_before, balance_after`,
      [p.id, userId],
    );
    expect(rows[0]).toEqual({ balance_before: '0.000', balance_after: '4.000' });
  });

  it('usuário é obrigatório e precisa existir (auditoria de quem fez)', async () => {
    const p = await createProduct(pool);
    const e = await pgError(
      pool.query(`INSERT INTO stock_movements (product_id, user_id, type, quantity) VALUES ($1, '00000000-0000-0000-0000-000000000000', 'ENTRADA', 1)`, [p.id]),
    );
    expect(e?.code).toBe('23503');
  });

  it('chave de idempotência repetida é recusada pelo banco (unicidade)', async () => {
    const p = await createProduct(pool);
    const key = '5b6d3c1e-9f0a-4a52-8f6e-2f6f3a1b7c01';
    await mov(p.id, 'ENTRADA', 1, { idempotencyKey: key });
    const e = await pgError(mov(p.id, 'ENTRADA', 1, { idempotencyKey: key }));
    expect(e?.code).toBe('23505');
    expect(e?.constraint).toBe('stock_movements_idempotency_key_key');
    expect(await stockOf(pool, p.id)).toBe('1.000'); // a segunda NÃO entrou no saldo
  });
});

describe('saldo: proteção contra alteração direta', () => {
  it('UPDATE direto de current_stock é recusado (ST005)', async () => {
    const p = await createProduct(pool);
    expect((await pgError(pool.query(`UPDATE products SET current_stock = 999 WHERE id = $1`, [p.id])))?.code).toBe('ST005');
    expect(await stockOf(pool, p.id)).toBe('0.000');
  });

  it('INSERT de produto já com saldo é recusado (ST005): o saldo inicial entra por movimentação', async () => {
    const e = await pgError(pool.query(`INSERT INTO products (sku, name, current_stock) VALUES ('COM-SALDO', 'x', 50)`));
    expect(e?.code).toBe('ST005');
  });

  it('atualizar OUTROS campos do produto continua permitido (preço, nome, estoque de segurança)', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    await pool.query(`UPDATE products SET name = 'Novo nome', sale_price = 99.9, safety_stock = 7 WHERE id = $1`, [p.id]);
    const { rows } = await pool.query(`SELECT name, sale_price, safety_stock, current_stock FROM products WHERE id = $1`, [p.id]);
    expect(rows[0]).toEqual({ name: 'Novo nome', sale_price: '99.90', safety_stock: '7.000', current_stock: '5.000' });
  });

  it('saldo negativo é recusado mesmo inserindo direto no produto (guarda ST005 + CHECK como segunda barreira)', async () => {
    const e = await pgError(pool.query(`INSERT INTO products (sku, name, current_stock) VALUES ('NEG', 'x', -1)`));
    expect(['ST005', '23514']).toContain(e?.code);
  });
});

describe('saldo: situação (ZERADO / BAIXO / OK) e alertas de estoque mínimo', () => {
  async function statusFor(stock: number, safety: number) {
    const p = await createProduct(pool, { safetyStock: safety });
    if (stock > 0) await mov(p.id, 'ENTRADA', stock);
    const { rows } = await pool.query(`SELECT stock_status FROM v_product_balances WHERE id = $1`, [p.id]);
    return rows[0].stock_status as string;
  }

  it.each([
    [0, 10, 'ZERADO'],
    [0, 0, 'ZERADO'],
    [1, 10, 'BAIXO'],
    [10, 10, 'BAIXO'], // no limite do estoque de segurança já é alerta
    [10.001, 10, 'OK'],
    [50, 10, 'OK'],
    [1, 0, 'OK'], // sem estoque de segurança, qualquer saldo positivo está OK
  ])('saldo %s com estoque de segurança %s -> %s', async (stock, safety, expected) => {
    expect(await statusFor(stock, safety)).toBe(expected);
  });

  it('v_low_stock lista só ZERADO e BAIXO, zerados primeiro, com a falta calculada', async () => {
    const zero = await createProduct(pool, { sku: 'ALERTA-ZERO', safetyStock: 10 });
    const low = await createProduct(pool, { sku: 'ALERTA-BAIXO', safetyStock: 10 });
    const ok = await createProduct(pool, { sku: 'ALERTA-OK', safetyStock: 10 });
    await mov(low.id, 'ENTRADA', 4);
    await mov(ok.id, 'ENTRADA', 30);

    const { rows } = await pool.query(`SELECT sku, stock_status, shortfall FROM v_low_stock WHERE sku LIKE 'ALERTA-%'`);
    expect(rows.map((r) => r.sku)).toEqual(['ALERTA-ZERO', 'ALERTA-BAIXO']);
    expect(rows[0]).toMatchObject({ stock_status: 'ZERADO', shortfall: '10.000' });
    expect(rows[1]).toMatchObject({ stock_status: 'BAIXO', shortfall: '6.000' });
    expect(zero.id).toBeTruthy();
  });

  it('produto inativo não aparece em saldos nem em alertas', async () => {
    const p = await createProduct(pool, { sku: 'INATIVO-1', safetyStock: 10 });
    await pool.query(`UPDATE products SET is_active = false WHERE id = $1`, [p.id]);
    const a = await pool.query(`SELECT 1 FROM v_product_balances WHERE sku = 'INATIVO-1'`);
    const b = await pool.query(`SELECT 1 FROM v_low_stock WHERE sku = 'INATIVO-1'`);
    expect(a.rowCount).toBe(0);
    expect(b.rowCount).toBe(0);
  });

  it('v_low_stock mostra o fornecedor preferido', async () => {
    const p = await createProduct(pool, { sku: 'COM-FORN', safetyStock: 5 });
    const { rows: s } = await pool.query(`INSERT INTO suppliers (name) VALUES ('Distribuidora Sul') RETURNING id`);
    await pool.query(`INSERT INTO product_suppliers (product_id, supplier_id, is_preferred) VALUES ($1, $2, true)`, [p.id, s[0].id]);
    const { rows } = await pool.query(`SELECT preferred_supplier FROM v_low_stock WHERE sku = 'COM-FORN'`);
    expect(rows[0].preferred_supplier).toBe('Distribuidora Sul');
  });

  it('só pode haver UM fornecedor preferido por produto', async () => {
    const p = await createProduct(pool);
    const a = (await pool.query(`INSERT INTO suppliers (name) VALUES ('A') RETURNING id`)).rows[0].id;
    const b = (await pool.query(`INSERT INTO suppliers (name) VALUES ('B') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO product_suppliers (product_id, supplier_id, is_preferred) VALUES ($1, $2, true)`, [p.id, a]);
    const e = await pgError(pool.query(`INSERT INTO product_suppliers (product_id, supplier_id, is_preferred) VALUES ($1, $2, true)`, [p.id, b]));
    expect(e?.code).toBe('23505');
  });
});

describe('saldo: consistência com um modelo de referência (sequências aleatórias)', () => {
  /** Gerador determinístico (mulberry32): a falha, se houver, é reproduzível pela semente. */
  function rng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each([1, 2, 3, 4, 5])('semente %i: 120 operações aleatórias batem com o modelo em memória, passo a passo', async (seed) => {
    const rand = rng(seed);
    const p = await createProduct(pool, { unit: 'KG' });
    let model = 0; // em milésimos (inteiros): sem erro de ponto flutuante no modelo
    let accepted = 0;
    let refused = 0;

    for (let i = 0; i < 120; i++) {
      const type = rand() < 0.5 ? 'ENTRADA' : 'SAIDA';
      const milli = 1 + Math.floor(rand() * 5_000);
      const qty = (milli / 1000).toFixed(3);
      const expectOk = type === 'ENTRADA' || model - milli >= 0;
      const result = await pgError(mov(p.id, type, qty));

      if (expectOk) {
        expect(result).toBeNull();
        model += type === 'ENTRADA' ? milli : -milli;
        accepted++;
      } else {
        expect(result?.code).toBe('ST001');
        refused++;
      }
      expect(await stockOf(pool, p.id)).toBe((model / 1000).toFixed(3));
    }

    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThanOrEqual(0);

    // invariantes finais: saldo = soma das movimentações, cadeia de saldos sem buracos, nunca negativo
    const { rows: inv } = await pool.query(
      `SELECT p.current_stock = COALESCE(SUM(m.signed_quantity), 0) AS sum_ok,
              COALESCE(MIN(m.balance_after), 0) >= 0 AS never_negative
         FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id
        WHERE p.id = $1 GROUP BY p.id`,
      [p.id],
    );
    expect(inv[0]).toEqual({ sum_ok: true, never_negative: true });

    const { rows: chain } = await pool.query(`SELECT balance_before, balance_after FROM stock_movements WHERE product_id = $1 ORDER BY id`, [p.id]);
    chain.forEach((row, i) => {
      expect(row.balance_before).toBe(i === 0 ? '0.000' : chain[i - 1].balance_after);
    });
  });
});
