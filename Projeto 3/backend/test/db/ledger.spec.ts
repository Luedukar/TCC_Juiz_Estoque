/**
 * Auditoria e imutabilidade: nenhuma movimentação pode ser apagada ou alterada, apenas estornada;
 * toda alteração de cadastro deixa rastro; concorrência não corrompe o saldo.
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

const mov = (productId: string, type: 'ENTRADA' | 'SAIDA', quantity: number, extra: object = {}) =>
  insertMovement(pool, { productId, userId, type, quantity, ...extra });

describe('imutabilidade das movimentações', () => {
  it('UPDATE é recusado (ST003) e a movimentação permanece intacta', async () => {
    const p = await createProduct(pool);
    const m = await mov(p.id, 'ENTRADA', 10);
    expect((await pgError(pool.query(`UPDATE stock_movements SET quantity = 1 WHERE id = $1`, [m.id])))?.code).toBe('ST003');
    expect((await pgError(pool.query(`UPDATE stock_movements SET notes = 'x' WHERE id = $1`, [m.id])))?.code).toBe('ST003');
    expect((await pgError(pool.query(`UPDATE stock_movements SET user_id = user_id WHERE id = $1`, [m.id])))?.code).toBe('ST003');
    const { rows } = await pool.query(`SELECT quantity FROM stock_movements WHERE id = $1`, [m.id]);
    expect(rows[0].quantity).toBe('10.000');
  });

  it('DELETE é recusado (ST003)', async () => {
    const p = await createProduct(pool);
    const m = await mov(p.id, 'ENTRADA', 10);
    expect((await pgError(pool.query(`DELETE FROM stock_movements WHERE id = $1`, [m.id])))?.code).toBe('ST003');
    const { rowCount } = await pool.query(`SELECT 1 FROM stock_movements WHERE id = $1`, [m.id]);
    expect(rowCount).toBe(1);
  });

  it('TRUNCATE é recusado (ST003)', async () => {
    expect((await pgError(pool.query(`TRUNCATE stock_movements`)))?.code).toBe('ST003');
  });

  it('apagar o produto ou o usuário que têm movimentações é recusado (FK RESTRICT)', async () => {
    const owner = await createUser(pool);
    const p = await createProduct(pool);
    await insertMovement(pool, { productId: p.id, userId: owner.id, type: 'ENTRADA', quantity: 1 });
    expect((await pgError(pool.query(`DELETE FROM products WHERE id = $1`, [p.id])))?.code).toBe('23503');
    expect((await pgError(pool.query(`DELETE FROM users WHERE id = $1`, [owner.id])))?.code).toBe('23503');
  });

  it('o log de auditoria também é imutável (UPDATE, DELETE e TRUNCATE)', async () => {
    await createProduct(pool); // gera ao menos uma linha de auditoria
    expect((await pgError(pool.query(`UPDATE audit_log SET action = 'DELETE'`)))?.code).toBe('ST003');
    expect((await pgError(pool.query(`DELETE FROM audit_log`)))?.code).toBe('ST003');
    expect((await pgError(pool.query(`TRUNCATE audit_log`)))?.code).toBe('ST003');
  });
});

describe('estorno (a única forma de corrigir)', () => {
  it('estornar uma ENTRADA cria uma SAÍDA do mesmo valor e devolve o saldo ao que era', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 20);
    const original = await mov(p.id, 'ENTRADA', 5); // saldo 25
    const rev = await mov(p.id, 'SAIDA', 5, { reversalOfId: original.id, reason: 'ESTORNO' });
    expect(rev.reason).toBe('ESTORNO');
    expect(rev.balance_before).toBe('25.000');
    expect(rev.balance_after).toBe('20.000');
    expect(await stockOf(pool, p.id)).toBe('20.000');
    // a original continua no histórico
    const { rowCount } = await pool.query(`SELECT 1 FROM stock_movements WHERE id = $1`, [original.id]);
    expect(rowCount).toBe(1);
  });

  it('estornar uma SAÍDA cria uma ENTRADA e devolve a mercadoria ao saldo', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 10);
    const out = await mov(p.id, 'SAIDA', 4);
    await mov(p.id, 'ENTRADA', 4, { reversalOfId: out.id, reason: 'ESTORNO' });
    expect(await stockOf(pool, p.id)).toBe('10.000');
  });

  it('o motivo ESTORNO é forçado quando há reversal_of_id', async () => {
    const p = await createProduct(pool);
    const original = await mov(p.id, 'ENTRADA', 5);
    const rev = await mov(p.id, 'SAIDA', 5, { reversalOfId: original.id, reason: 'VENDA' });
    expect(rev.reason).toBe('ESTORNO');
  });

  it('não é possível estornar a mesma movimentação duas vezes (unicidade)', async () => {
    const p = await createProduct(pool);
    const original = await mov(p.id, 'ENTRADA', 5);
    await mov(p.id, 'SAIDA', 5, { reversalOfId: original.id });
    await mov(p.id, 'ENTRADA', 100); // há saldo de sobra, então só a unicidade pode recusar
    const e = await pgError(mov(p.id, 'SAIDA', 5, { reversalOfId: original.id }));
    expect(e?.code).toBe('23505');
  });

  it('um estorno não pode ser estornado (ST002)', async () => {
    const p = await createProduct(pool);
    const original = await mov(p.id, 'ENTRADA', 5);
    const rev = await mov(p.id, 'SAIDA', 5, { reversalOfId: original.id });
    expect((await pgError(mov(p.id, 'ENTRADA', 5, { reversalOfId: rev.id })))?.code).toBe('ST002');
  });

  it.each([
    ['tipo igual ao da original', { type: 'ENTRADA' as const, quantity: 5, sameProduct: true }],
    ['quantidade diferente', { type: 'SAIDA' as const, quantity: 4, sameProduct: true }],
    ['produto diferente', { type: 'SAIDA' as const, quantity: 5, sameProduct: false }],
  ])('estorno inválido: %s (ST002)', async (_name, bad) => {
    const p = await createProduct(pool);
    const other = await createProduct(pool);
    await mov(other.id, 'ENTRADA', 50);
    const original = await mov(p.id, 'ENTRADA', 5);
    const e = await pgError(mov(bad.sameProduct ? p.id : other.id, bad.type, bad.quantity, { reversalOfId: original.id }));
    expect(e?.code).toBe('ST002');
    expect(await stockOf(pool, p.id)).toBe('5.000');
  });

  it('estorno de movimentação inexistente é recusado', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    const e = await pgError(mov(p.id, 'SAIDA', 5, { reversalOfId: 999_999_999 }));
    expect(['ST002', '23503']).toContain(e?.code);
  });

  it('estornar uma entrada cujo saldo já foi consumido é recusado (ST001): o estoque nunca fica negativo', async () => {
    const p = await createProduct(pool);
    const entrada = await mov(p.id, 'ENTRADA', 10);
    await mov(p.id, 'SAIDA', 8); // saldo 2
    const e = await pgError(mov(p.id, 'SAIDA', 10, { reversalOfId: entrada.id }));
    expect(e?.code).toBe('ST001');
    expect(await stockOf(pool, p.id)).toBe('2.000');
  });

  it('motivo ESTORNO sem reversal_of_id é recusado (CHECK)', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    expect((await pgError(mov(p.id, 'SAIDA', 1, { reason: 'ESTORNO' })))?.code).toBe('23514');
  });

  it('v_kardex marca a movimentação estornada (reversed_by_id) e a que estorna (reversal_of_id)', async () => {
    const p = await createProduct(pool);
    const original = await mov(p.id, 'ENTRADA', 5);
    const rev = await mov(p.id, 'SAIDA', 5, { reversalOfId: original.id });
    const { rows } = await pool.query(`SELECT id, reversal_of_id, reversed_by_id FROM v_kardex WHERE product_id = $1 ORDER BY id`, [p.id]);
    expect(rows).toEqual([
      { id: original.id, reversal_of_id: null, reversed_by_id: rev.id },
      { id: rev.id, reversal_of_id: original.id, reversed_by_id: null },
    ]);
  });
});

describe('Kardex (v_kardex)', () => {
  it('em ordem cronológica, o saldo corrente encadeia: cada saldo anterior é o posterior da linha de cima', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 50);
    await mov(p.id, 'SAIDA', 12);
    await mov(p.id, 'ENTRADA', 7);
    await mov(p.id, 'SAIDA', 45);
    const { rows } = await pool.query(
      `SELECT type, quantity, balance_before, balance_after FROM v_kardex WHERE product_id = $1 ORDER BY created_at, id`,
      [p.id],
    );
    expect(rows.map((r) => [r.type, r.balance_before, r.balance_after])).toEqual([
      ['ENTRADA', '0.000', '50.000'],
      ['SAIDA', '50.000', '38.000'],
      ['ENTRADA', '38.000', '45.000'],
      ['SAIDA', '45.000', '0.000'],
    ]);
  });

  it('identifica quem fez cada movimentação, com data e hora', async () => {
    const ana = await createUser(pool, { name: 'Ana Souza' });
    const p = await createProduct(pool);
    await insertMovement(pool, { productId: p.id, userId: ana.id, type: 'ENTRADA', quantity: 1 });
    const { rows } = await pool.query(`SELECT user_name, created_at FROM v_kardex WHERE product_id = $1`, [p.id]);
    expect(rows[0].user_name).toBe('Ana Souza');
    expect(Math.abs(Date.now() - new Date(rows[0].created_at).getTime())).toBeLessThan(60_000);
  });
});

describe('auditoria de cadastros (audit_log)', () => {
  const auditFor = async (entity: string, entityId: string) =>
    (await pool.query(`SELECT action, user_id, old_data, new_data FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id`, [entity, entityId])).rows;

  it('registra a criação do produto', async () => {
    const p = await createProduct(pool, { sku: 'AUD-1' });
    const rows = await auditFor('products', p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'INSERT', old_data: null });
    expect(rows[0].new_data.sku).toBe('AUD-1');
  });

  it('registra quem alterou (app.current_user_id) e o antes/depois de uma mudança de preço', async () => {
    const p = await createProduct(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      await client.query(`UPDATE products SET cost_price = 15.5 WHERE id = $1`, [p.id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const rows = await auditFor('products', p.id);
    const update = rows.find((r) => r.action === 'UPDATE')!;
    expect(update.user_id).toBe(userId);
    expect(Number(update.old_data.cost_price)).toBe(10); // jsonb guarda o número, não o texto "10.00"
    expect(Number(update.new_data.cost_price)).toBe(15.5);
  });

  it('o contexto de usuário NÃO vaza entre transações (set_config local)', async () => {
    const p = await createProduct(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
      await client.query('COMMIT');
      await client.query(`UPDATE products SET name = 'sem contexto' WHERE id = $1`, [p.id]);
    } finally {
      client.release();
    }
    const update = (await auditFor('products', p.id)).find((r) => r.action === 'UPDATE')!;
    expect(update.user_id).toBeNull();
  });

  it('movimentações de estoque NÃO poluem o audit_log (a mudança de saldo é ruído)', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 5);
    await mov(p.id, 'SAIDA', 2);
    const rows = await auditFor('products', p.id);
    expect(rows.map((r) => r.action)).toEqual(['INSERT']);
  });

  it('nunca grava o hash da senha no log de auditoria', async () => {
    const u = await createUser(pool);
    await pool.query(`UPDATE users SET name = 'Outro Nome' WHERE id = $1`, [u.id]);
    const rows = await auditFor('users', u.id);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.new_data).not.toHaveProperty('password_hash');
      expect(r.old_data ?? {}).not.toHaveProperty('password_hash');
    }
  });

  it('registra a exclusão de um produto sem movimentações', async () => {
    const p = await createProduct(pool);
    await pool.query(`DELETE FROM products WHERE id = $1`, [p.id]);
    const rows = await auditFor('products', p.id);
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'DELETE']);
  });
});

describe('concorrência', () => {
  it('50 saídas simultâneas de 3 sobre saldo 100: exatamente 33 passam, 17 são recusadas, saldo 1', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 100);
    const results = await Promise.all(Array.from({ length: 50 }, () => pgError(mov(p.id, 'SAIDA', 3))));
    const ok = results.filter((r) => r === null).length;
    const refused = results.filter((r) => r?.code === 'ST001').length;
    expect({ ok, refused }).toEqual({ ok: 33, refused: 17 });
    expect(await stockOf(pool, p.id)).toBe('1.000');
  });

  it('entradas e saídas misturadas em paralelo: o saldo final bate com a soma e a cadeia não tem buracos', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 1000);
    const ops = Array.from({ length: 60 }, (_, i) => pgError(mov(p.id, i % 3 === 0 ? 'ENTRADA' : 'SAIDA', 1 + (i % 7))));
    expect((await Promise.all(ops)).every((r) => r === null)).toBe(true);

    const { rows: sum } = await pool.query(`SELECT SUM(signed_quantity) AS s FROM stock_movements WHERE product_id = $1`, [p.id]);
    expect(await stockOf(pool, p.id)).toBe(sum[0].s);

    const { rows: chain } = await pool.query(`SELECT balance_before, balance_after FROM stock_movements WHERE product_id = $1 ORDER BY created_at, id`, [p.id]);
    chain.forEach((row, i) => i > 0 && expect(row.balance_before).toBe(chain[i - 1].balance_after));
  });

  it('Kardex coerente sob concorrência: ordenado por data/hora, cada saldo anterior é o posterior da linha de cima', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 500);
    await Promise.all(Array.from({ length: 40 }, (_, i) => mov(p.id, i % 2 ? 'ENTRADA' : 'SAIDA', 1 + (i % 5))));
    const { rows } = await pool.query(`SELECT balance_before, balance_after FROM v_kardex WHERE product_id = $1 ORDER BY created_at, id`, [p.id]);
    expect(rows).toHaveLength(41);
    rows.forEach((row, i) => i > 0 && expect(row.balance_before).toBe(rows[i - 1].balance_after));
  });

  it('o mesmo Idempotency-Key enviado 10 vezes ao mesmo tempo grava UMA movimentação', async () => {
    const p = await createProduct(pool);
    const key = '1c9d4e0a-33aa-4c6b-9a77-6c0d5b1e2f10';
    const results = await Promise.all(Array.from({ length: 10 }, () => pgError(mov(p.id, 'ENTRADA', 5, { idempotencyKey: key }))));
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.code === '23505')).toHaveLength(9);
    expect(await stockOf(pool, p.id)).toBe('5.000');
  });

  it('dois estornos simultâneos da mesma movimentação: só um vale', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 100);
    const original = await mov(p.id, 'ENTRADA', 10);
    const results = await Promise.all([
      pgError(mov(p.id, 'SAIDA', 10, { reversalOfId: original.id })),
      pgError(mov(p.id, 'SAIDA', 10, { reversalOfId: original.id })),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await stockOf(pool, p.id)).toBe('100.000');
  });

  it('transação revertida não deixa rastro: nem movimentação nem alteração de saldo', async () => {
    const p = await createProduct(pool);
    await mov(p.id, 'ENTRADA', 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO stock_movements (product_id, user_id, type, quantity) VALUES ($1, $2, 'SAIDA', 4)`, [p.id, userId]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await stockOf(pool, p.id)).toBe('10.000');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1`, [p.id]);
    expect(rows[0].n).toBe(1);
  });
});
