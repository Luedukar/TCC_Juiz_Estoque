import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { HttpError } from '../errors';
import { allowRoles, authenticate } from '../middleware/auth';
import { PoolClient } from 'pg';
import { calculateStockBalances, StockLedgerEntry } from '../services/stock';

export const movementRouter = Router();
movementRouter.use(authenticate);

const lineSchema = z.object({ product_id: z.number().int().positive(), quantity: z.number().positive().finite(), unit_cost: z.number().nonnegative().finite().optional() });
const createSchema = z.object({
  type: z.enum(['IN', 'OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT']),
  supplier_id: z.number().int().positive().optional(),
  reference: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(1000).optional(),
  idempotency_key: z.string().uuid().optional(),
  items: z.array(lineSchema).min(1).max(500),
});

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function assertStockAvailable(client: PoolClient, items: z.infer<typeof lineSchema>[], direction: 1 | -1) {
  const totals = new Map<number, number>();
  for (const item of items) totals.set(item.product_id, (totals.get(item.product_id) || 0) + item.quantity);
  const ids = [...totals.keys()].sort((a, b) => a - b);
  await client.query('SELECT id FROM products WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
  const found = await client.query('SELECT id FROM products WHERE id = ANY($1::bigint[]) AND active = true', [ids]);
  if (found.rowCount !== ids.length) throw new HttpError(400, 'Produto inexistente ou inativo.', 'INVALID_PRODUCT');
  if (direction < 0) {
    const ledger = await client.query(`
      SELECT i.product_id, sm.movement_type, i.quantity
      FROM stock_movement_items i JOIN stock_movements sm ON sm.id=i.movement_id
      WHERE i.product_id = ANY($1::bigint[])`, [ids]);
    const balances = calculateStockBalances(ledger.rows as StockLedgerEntry[]);
    for (const [productId, requested] of totals) {
      if ((balances.get(productId) ?? 0) < requested) throw new HttpError(409, `Saldo insuficiente para o produto ${productId}.`, 'INSUFFICIENT_STOCK');
    }
  }
}

movementRouter.post('/', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body);
    if (input.type.startsWith('ADJUSTMENT_') && req.user!.role !== 'MANAGER') throw new HttpError(403, 'Somente gerente pode ajustar estoque.', 'FORBIDDEN');
    if (req.user!.role !== 'MANAGER' && input.items.some(i => i.unit_cost !== undefined)) throw new HttpError(403, 'Somente gerente pode informar custos.', 'FORBIDDEN');
    if (new Set(input.items.map(i => i.product_id)).size !== input.items.length) throw new HttpError(400, 'Cada produto deve aparecer uma única vez por movimentação.', 'DUPLICATE_PRODUCT');
    const id = await inTransaction(async client => {
      if (input.idempotency_key) {
        // Serializa repetições simultâneas com a mesma chave antes de validar saldo.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.idempotency_key]);
        const existing = await client.query('SELECT id FROM stock_movements WHERE idempotency_key=$1', [input.idempotency_key]);
        if (existing.rowCount) return Number(existing.rows[0].id);
      }
      await assertStockAvailable(client, input.items, input.type.endsWith('_OUT') || input.type === 'OUT' ? -1 : 1);
      const head = await client.query(`INSERT INTO stock_movements (movement_type,user_id,supplier_id,reference,notes,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [input.type, req.user!.id, input.supplier_id ?? null, input.reference ?? null, input.notes ?? null, input.idempotency_key ?? null]);
      for (const item of input.items) {
        await client.query('INSERT INTO stock_movement_items (movement_id,product_id,quantity,unit_cost) VALUES ($1,$2,$3,$4)',
          [head.rows[0].id, item.product_id, item.quantity, item.unit_cost ?? null]);
      }
      return Number(head.rows[0].id);
    });
    res.status(201).json({ id, status: 'POSTED' });
  } catch (error) { next(error); }
});

movementRouter.post('/:id/reversal', allowRoles('MANAGER'), async (req, res, next) => {
  try {
    const originalId = z.coerce.number().int().positive().parse(req.params.id);
    const reversalId = await inTransaction(async client => {
      const original = await client.query('SELECT * FROM stock_movements WHERE id=$1 FOR UPDATE', [originalId]);
      if (!original.rowCount) throw new HttpError(404, 'Movimentação não encontrada.', 'NOT_FOUND');
      if (original.rows[0].movement_type.startsWith('REVERSAL_')) throw new HttpError(409, 'Estorno de estorno não é permitido.', 'INVALID_REVERSAL');
      if (await client.query('SELECT 1 FROM stock_movements WHERE reverses_movement_id=$1', [originalId]).then(r => r.rowCount)) throw new HttpError(409, 'Movimentação já estornada.', 'ALREADY_REVERSED');
      const items = await client.query('SELECT * FROM stock_movement_items WHERE movement_id=$1 ORDER BY product_id', [originalId]);
      const type = ['IN', 'ADJUSTMENT_IN'].includes(original.rows[0].movement_type) ? 'REVERSAL_OUT' : 'REVERSAL_IN';
      await assertStockAvailable(client, items.rows.map(i => ({ product_id: Number(i.product_id), quantity: Number(i.quantity) })), type === 'REVERSAL_OUT' ? -1 : 1);
      const head = await client.query(`INSERT INTO stock_movements (movement_type,user_id,reference,notes,reverses_movement_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`, [type, req.user!.id, `Estorno de #${originalId}`, req.body?.notes ?? null, originalId]);
      for (const item of items.rows) await client.query(`INSERT INTO stock_movement_items (movement_id,product_id,quantity,unit_cost,reverses_item_id)
        VALUES ($1,$2,$3,$4,$5)`, [head.rows[0].id, item.product_id, item.quantity, item.unit_cost, item.id]);
      return Number(head.rows[0].id);
    });
    res.status(201).json({ id: reversalId, reverses_movement_id: originalId, status: 'POSTED' });
  } catch (error) { next(error); }
});

movementRouter.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const result = await pool.query(`SELECT m.id,m.movement_type,m.status,m.occurred_at,m.user_id,u.name AS user_name,m.supplier_id,m.reference,m.notes,m.reverses_movement_id,
      json_agg(json_build_object('product_id',i.product_id,'sku',p.sku,'product_name',p.name,'quantity',i.quantity,
        'unit_cost', CASE WHEN $3::boolean THEN i.unit_cost ELSE NULL END) ORDER BY i.id) AS items
      FROM stock_movements m JOIN app_users u ON u.id=m.user_id JOIN stock_movement_items i ON i.movement_id=m.id JOIN products p ON p.id=i.product_id
      GROUP BY m.id,u.name ORDER BY m.occurred_at DESC,m.id DESC LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit, req.user!.role === 'MANAGER']);
    res.json({ data: result.rows, page, limit });
  } catch (error) { next(error); }
});

movementRouter.get('/balances', async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT product_id,sku,barcode,name,safety_stock,quantity_on_hand,is_below_safety_stock FROM inventory_balances ORDER BY name`);
    res.json({ data: result.rows });
  } catch (error) { next(error); }
});
