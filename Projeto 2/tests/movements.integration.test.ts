import request from 'supertest';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import type { Express } from 'express';

const testDatabaseUrl = process.env.DATABASE_URL_TEST;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase('movimentações HTTP (PostgreSQL dedicado)', () => {
  let app: Express;
  let pool: typeof import('../src/db').pool;
  let userId: number;
  let productId: number;
  let token: string;

  beforeAll(async () => {
    if (!testDatabaseUrl) return;
    const configuredDatabaseUrl = process.env.DATABASE_URL;
    if (configuredDatabaseUrl && new URL(configuredDatabaseUrl).pathname === new URL(testDatabaseUrl).pathname) {
      throw new Error('DATABASE_URL_TEST deve apontar para banco diferente de DATABASE_URL.');
    }
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'integration-test-secret-at-least-32-characters';
    process.env.CLIENT_ORIGIN = 'http://localhost:5173';

    ({ app } = await import('../src/app'));
    ({ pool } = await import('../src/db'));

    const suffix = randomUUID();
    const email = `integration-${suffix}@example.test`;
    const passwordHash = await bcrypt.hash('test-password', 4);
    const user = await pool.query(`INSERT INTO app_users (name,email,password_hash,role) VALUES ($1,$2,$3,'MANAGER') RETURNING id`, ['Teste Integração', email, passwordHash]);
    userId = Number(user.rows[0].id);
    const product = await pool.query(`INSERT INTO products (sku,name,sale_price,safety_stock) VALUES ($1,$2,10,2) RETURNING id`, [`TEST-${suffix}`, 'Produto de teste']);
    productId = Number(product.rows[0].id);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'test-password' }).expect(200);
    token = login.body.token;
  }, 20_000);

  afterAll(async () => { if (pool) await pool.end(); });

  it('registra entrada e saída e retorna saldo consistente', async () => {
    await request(app).post('/api/movements').set('Authorization', `Bearer ${token}`).send({
      type: 'IN', reference: 'Compra de teste', items: [{ product_id: productId, quantity: 10 }],
    }).expect(201);

    await request(app).post('/api/movements').set('Authorization', `Bearer ${token}`).send({
      type: 'OUT', reference: 'Venda de teste', items: [{ product_id: productId, quantity: 3 }],
    }).expect(201);

    const balances = await request(app).get('/api/movements/balances').set('Authorization', `Bearer ${token}`).expect(200);
    const productBalance = balances.body.data.find((row: { product_id: number }) => row.product_id === productId);
    expect(productBalance).toMatchObject({ product_id: productId, quantity_on_hand: '7.000', is_below_safety_stock: false });
  });

  it('recusa saída maior que o saldo disponível', async () => {
    const response = await request(app).post('/api/movements').set('Authorization', `Bearer ${token}`).send({
      type: 'OUT', items: [{ product_id: productId, quantity: 99 }],
    }).expect(409);
    expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
  });
});
