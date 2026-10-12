import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const explicitlyAllowed = process.env.ALLOW_NON_TEST_DATABASE === 'true';

if (databaseUrl && !/(^|[_-])test([_-]|$)/i.test(databaseName) && !explicitlyAllowed) {
  throw new Error(
    'TEST_DATABASE_URL must point to a database whose name includes "test". ' +
    'Set ALLOW_NON_TEST_DATABASE=true only if you intentionally use a disposable database.'
  );
}

suite('stock movement API (PostgreSQL integration)', () => {
  const schemaName = `inventory_test_${randomBytes(8).toString('hex')}`;
  let adminPool: Pool;
  let testPool: Pool;
  let app: Express;
  let userId: string;
  let productId: string;
  let token: string;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('TEST_DATABASE_URL is required for integration tests');
    }

    process.env.JWT_SECRET ??= 'integration-test-secret-that-is-longer-than-32';
    adminPool = new Pool({ connectionString: databaseUrl });
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query(`CREATE SCHEMA "${schemaName}"`);
      await adminClient.query(`SET search_path TO "${schemaName}", public`);
      const schema = await readFile(path.resolve(process.cwd(), 'schema.sql'), 'utf8');
      await adminClient.query(schema);
    } finally {
      adminClient.release();
      await adminPool.end();
    }

    testPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`
    });

    const { createApp } = await import('../../src/app');
    app = createApp(testPool);
    const passwordHash = await bcrypt.hash('integration-password', 4);
    const userResult = await testPool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Integration Stockist', $1, $2, 'stockist')
       RETURNING id`,
      [`stockist-${schemaName}@example.test`, passwordHash]
    );
    userId = userResult.rows[0].id;

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: `stockist-${schemaName}@example.test`, password: 'integration-password' })
      .expect(200);
    token = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (databaseUrl) {
      const cleanupPool = new Pool({ connectionString: databaseUrl });
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    }
  });

  async function createProduct(sku: string): Promise<string> {
    const result = await testPool.query(
      `INSERT INTO products (sku, name, sale_price, cost_price, safety_stock)
       VALUES ($1, 'Integration Product', 10, 5, 2)
       RETURNING id`,
      [sku]
    );
    return result.rows[0].id as string;
  }

  async function currentBalance(id: string): Promise<number> {
    const result = await testPool.query(
      'SELECT quantity FROM stock_balances WHERE product_id = $1',
      [id]
    );
    return Number(result.rows[0].quantity);
  }

  it('records entry and exit, persists the balance and attributes both to the authenticated user', async () => {
    productId = await createProduct(`IN-${schemaName}`);

    const entry = await request(app)
      .post('/api/movements?type=in')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity: 10, reason: 'Initial delivery', reference: 'PO-100' })
      .expect(201);

    expect(entry.body.data).toMatchObject({
      productId,
      userId,
      type: 'in',
      reason: 'Initial delivery',
      reference: 'PO-100'
    });
    expect(Number(entry.body.data.quantity)).toBe(10);
    expect(entry.body.data.occurredAt).toBeTruthy();
    expect(await currentBalance(productId)).toBe(10);

    const exit = await request(app)
      .post('/api/movements?type=out')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity: 3.25, reason: 'Store sale' })
      .expect(201);

    expect(exit.body.data).toMatchObject({ productId, userId, type: 'out' });
    expect(Number(exit.body.data.quantity)).toBe(3.25);
    expect(await currentBalance(productId)).toBe(6.75);

    const balance = await request(app)
      .get(`/api/products/${productId}/balance`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Number(balance.body.data.quantity)).toBe(6.75);

    const kardex = await request(app)
      .get(`/api/products/${productId}/kardex`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(kardex.body.data).toHaveLength(2);
    expect(kardex.body.data.map((movement: { type: string }) => movement.type)).toEqual(['out', 'in']);
    expect(kardex.body.data.every((movement: { userId: string; userName: string }) =>
      movement.userId === userId && movement.userName === 'Integration Stockist'
    )).toBe(true);
  });

  it('rejects an exit beyond the available stock without changing the balance', async () => {
    productId = await createProduct(`LOW-${schemaName}`);

    const response = await request(app)
      .post('/api/movements?type=out')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, quantity: 1 })
      .expect(409);

    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await currentBalance(productId)).toBe(0);
    const movements = await testPool.query(
      'SELECT count(*)::int AS count FROM stock_movements WHERE product_id = $1',
      [productId]
    );
    expect(movements.rows[0].count).toBe(0);
  });
});
