import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Client, Pool } from 'pg';
import { adminUrl, TEMPLATE_DB, withDb } from './db-url';

export interface TestDb {
  url: string;
  pool: Pool;
  drop: () => Promise<void>;
}

/** Banco exclusivo do arquivo de teste (clone do template): sem interferência entre testes paralelos. */
export async function createTestDb(): Promise<TestDb> {
  const name = `estoque_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    // CREATE DATABASE ... TEMPLATE exige que ninguém use o template: serializa as criações
    await admin.query('SELECT pg_advisory_lock(84720001)');
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
  } finally {
    await admin.end(); // encerrar a sessão libera o advisory lock
  }

  const url = withDb(adminUrl(), name);
  const pool = new Pool({ connectionString: url, max: 12 });
  pool.on('error', () => undefined); // conexão ociosa derrubada (testes de queda) não pode matar o worker
  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const c = new Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

export interface SeedUser {
  id: string;
  email: string;
  password: string;
  role: 'GERENTE' | 'ESTOQUISTA';
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createUser(
  pool: Pool,
  opts: { role?: 'GERENTE' | 'ESTOQUISTA'; email?: string; password?: string; name?: string; active?: boolean } = {},
): Promise<SeedUser> {
  const role = opts.role ?? 'ESTOQUISTA';
  const email = opts.email ?? `${role.toLowerCase()}-${uniq()}@loja.com`;
  const password = opts.password ?? 'SenhaForte#2026';
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.name ?? `Usuário ${role}`, email, bcrypt.hashSync(password, 4), role, opts.active ?? true],
  );
  return { id: rows[0].id, email, password, role };
}

export interface SeedProduct {
  id: string;
  sku: string;
  barcode: string | null;
}

export async function createProduct(
  pool: Pool,
  opts: {
    sku?: string;
    barcode?: string | null;
    name?: string;
    unit?: string;
    safetyStock?: number;
    costPrice?: number;
    active?: boolean;
  } = {},
): Promise<SeedProduct> {
  const sku = opts.sku ?? `SKU-${uniq()}`.toUpperCase();
  const { rows } = await pool.query(
    `INSERT INTO products (sku, barcode, name, unit, safety_stock, cost_price, sale_price, is_active)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $6::numeric * 2, $7) RETURNING id, sku, barcode`,
    [
      sku,
      opts.barcode === undefined ? null : opts.barcode,
      opts.name ?? `Produto ${sku}`,
      opts.unit ?? 'UN',
      opts.safetyStock ?? 0,
      opts.costPrice ?? 10,
      opts.active ?? true,
    ],
  );
  return rows[0];
}

/** Insere uma movimentação direto no banco (o trigger calcula os saldos). */
export async function insertMovement(
  pool: Pool,
  m: {
    productId: string;
    userId: string;
    type: 'ENTRADA' | 'SAIDA';
    quantity: number | string;
    reason?: string;
    reversalOfId?: number | string | null;
    idempotencyKey?: string | null;
    unitCost?: number | null;
  },
) {
  const { rows } = await pool.query(
    `INSERT INTO stock_movements (product_id, user_id, type, reason, quantity, reversal_of_id, idempotency_key, unit_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, balance_before, balance_after, signed_quantity, reason, created_at`,
    [m.productId, m.userId, m.type, m.reason ?? 'OUTRO', m.quantity, m.reversalOfId ?? null, m.idempotencyKey ?? null, m.unitCost ?? null],
  );
  return rows[0] as {
    id: string;
    balance_before: string;
    balance_after: string;
    signed_quantity: string;
    reason: string;
    created_at: Date;
  };
}

export async function stockOf(pool: Pool, productId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT current_stock FROM products WHERE id = $1`, [productId]);
  return rows[0].current_stock as string;
}

/** Captura o erro de uma promessa (ou null) para asserções sobre SQLSTATE e mensagem. */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string; constraint?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { code?: string; message: string; constraint?: string };
  }
}
