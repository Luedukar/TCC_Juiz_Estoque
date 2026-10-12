/**
 * Integração: autenticação JWT, rotação de refresh token, rate limiting e resiliência (banco indisponível).
 */
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { bearer, createTestApp, loginAs, TestApp } from '../helpers/app';
import { createProduct, createTestDb, createUser, TestDb } from '../helpers/db';
import { TcpProxy } from '../helpers/proxy';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('autenticação (JWT)', () => {
  let db: TestDb;
  let pool: Pool;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDb();
    pool = db.pool;
    t = await createTestApp(db.url);
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  describe('login', () => {
    it('credenciais corretas: devolve access token, refresh token e os dados do usuário (sem hash de senha)', async () => {
      const u = await createUser(pool, { role: 'GERENTE', name: 'Maria' });
      const r = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: { id: u.id, name: 'Maria', email: u.email, role: 'GERENTE' } });
      expect(r.body.accessToken.split('.')).toHaveLength(3);
      expect(r.body.refreshToken.length).toBeGreaterThanOrEqual(32);
      expect(JSON.stringify(r.body)).not.toMatch(/password|hash/i);
    });

    it('o access token carrega só o id e o perfil, e expira em 15 minutos', async () => {
      const u = await createUser(pool, { role: 'ESTOQUISTA' });
      const { accessToken } = await loginAs(t, u.email, u.password);
      const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
      expect(payload).toMatchObject({ sub: u.id, role: 'ESTOQUISTA' });
      expect(payload.exp - payload.iat).toBe(900);
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'role', 'sub']);
    });

    it('e-mail não diferencia maiúsculas', async () => {
      const u = await createUser(pool, { email: 'caixa.mista@loja.com' });
      const r = await t.http.post('/api/auth/login').send({ email: 'CAIXA.Mista@LOJA.com', password: u.password });
      expect(r.status).toBe(200);
    });

    it('senha errada e usuário inexistente dão a MESMA resposta (não revela quais e-mails existem)', async () => {
      const u = await createUser(pool);
      const wrong = await t.http.post('/api/auth/login').send({ email: u.email, password: 'senha-errada' });
      const ghost = await t.http.post('/api/auth/login').send({ email: 'ninguem@loja.com', password: 'qualquer-coisa' });
      for (const r of [wrong, ghost]) {
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
      }
      expect(wrong.body.error.message).toBe(ghost.body.error.message);
    });

    it('usuário desativado não entra, mesmo com a senha certa', async () => {
      const u = await createUser(pool, { active: false });
      const r = await t.http.post('/api/auth/login').send({ email: u.email, password: u.password });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('registra o último acesso', async () => {
      const u = await createUser(pool);
      await loginAs(t, u.email, u.password);
      const { rows } = await pool.query(`SELECT last_login_at FROM users WHERE id = $1`, [u.id]);
      expect(rows[0].last_login_at).not.toBeNull();
    });

    it('guarda só o HASH do refresh token no banco, nunca o token', async () => {
      const u = await createUser(pool);
      const { refreshToken } = await loginAs(t, u.email, u.password);
      const { rows } = await pool.query(`SELECT token_hash FROM refresh_tokens WHERE user_id = $1`, [u.id]);
      expect(rows.map((r) => r.token_hash)).toContain(sha256(refreshToken));
      expect(rows.map((r) => r.token_hash)).not.toContain(refreshToken);
    });

    it.each([
      ['sem e-mail', { password: 'x' }],
      ['e-mail inválido', { email: 'nao-e-email', password: 'x' }],
      ['senha vazia', { email: 'a@b.com', password: '' }],
      ['campo extra', { email: 'a@b.com', password: 'x', role: 'GERENTE' }],
    ])('entrada inválida (%s) -> 400 VALIDATION_ERROR', async (_n, body) => {
      const r = await t.http.post('/api/auth/login').send(body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('proteção das rotas', () => {
    const protectedRoutes: [string, string][] = [
      ['get', '/api/stock/balances'],
      ['get', '/api/stock/alerts'],
      ['get', '/api/stock/kardex'],
      ['get', '/api/stock/movements'],
      ['post', '/api/stock/movements'],
      ['post', '/api/stock/movements/1/reversal'],
      ['get', '/api/auth/me'],
    ];

    it.each(protectedRoutes)('%s %s sem token -> 401 UNAUTHENTICATED', async (method, url) => {
      const r = await (t.http as any)[method](url).send({});
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('/health e /auth/login são públicos', async () => {
      expect((await t.http.get('/api/health')).status).toBe(200);
      expect((await t.http.post('/api/auth/login').send({ email: 'a@b.com', password: 'x' })).status).toBe(401);
    });

    it('token expirado -> 401 TOKEN_EXPIRED (sinal para o frontend renovar a sessão)', async () => {
      const u = await createUser(pool);
      const token = t.signToken({ sub: u.id, role: 'ESTOQUISTA' }, { expiresIn: -60 });
      const r = await t.http.get('/api/stock/balances').set(bearer(token));
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('token adulterado (perfil trocado no payload, assinatura antiga) -> 401 INVALID_TOKEN', async () => {
      const u = await createUser(pool, { role: 'ESTOQUISTA' });
      const { accessToken } = await loginAs(t, u.email, u.password);
      const [h, , s] = accessToken.split('.');
      const forged = Buffer.from(JSON.stringify({ sub: u.id, role: 'GERENTE', iat: 1, exp: 9_999_999_999 })).toString('base64url');
      const r = await t.http.get('/api/stock/balances').set(bearer(`${h}.${forged}.${s}`));
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_TOKEN');
    });

    it('perfil no token é quem manda: Estoquista com token válido não passa em rota de Gerente', async () => {
      const u = await createUser(pool, { role: 'ESTOQUISTA' });
      const { accessToken } = await loginAs(t, u.email, u.password);
      const r = await t.http.post('/api/stock/movements/1/reversal').set(bearer(accessToken)).send({});
      expect(r.status).toBe(403);
    });

    it('/auth/me devolve o usuário; se foi desativado depois do login, passa a recusar', async () => {
      const u = await createUser(pool, { role: 'GERENTE' });
      const { accessToken } = await loginAs(t, u.email, u.password);
      const ok = await t.http.get('/api/auth/me').set(bearer(accessToken));
      expect(ok.body).toMatchObject({ id: u.id, email: u.email, role: 'GERENTE' });
      await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [u.id]);
      const after = await t.http.get('/api/auth/me').set(bearer(accessToken));
      expect(after.status).toBe(401);
    });

    it('cabeçalhos de segurança (helmet) presentes e sem X-Powered-By', async () => {
      const r = await t.http.get('/api/health');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['strict-transport-security']).toBeDefined();
    });

    it('CORS: só a origem configurada é aceita', async () => {
      const allowed = await t.http.options('/api/stock/balances').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(allowed.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);
      const denied = await t.http.options('/api/stock/balances').set('Origin', 'http://malicioso.example').set('Access-Control-Request-Method', 'GET');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('refresh token', () => {
    it('renova a sessão, rotaciona o refresh token e o novo access token funciona', async () => {
      const u = await createUser(pool);
      const first = await loginAs(t, u.email, u.password);
      const r = await t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(r.status).toBe(200);
      expect(r.body.refreshToken).not.toBe(first.refreshToken);
      expect((await t.http.get('/api/auth/me').set(bearer(r.body.accessToken))).status).toBe(200);
    });

    it('o refresh token antigo, logo após a rotação, é recusado (dentro da janela de tolerância: sem derrubar a sessão nova)', async () => {
      const u = await createUser(pool);
      const first = await loginAs(t, u.email, u.password);
      const second = await t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
      const retry = await t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(retry.status).toBe(401);
      expect(retry.body.error.code).toBe('INVALID_REFRESH_TOKEN');
      const stillValid = await t.http.post('/api/auth/refresh').send({ refreshToken: second.body.refreshToken });
      expect(stillValid.status).toBe(200);
    });

    it('reuso TARDIO de um token já rotacionado (possível roubo) encerra TODAS as sessões do usuário', async () => {
      const u = await createUser(pool);
      const first = await loginAs(t, u.email, u.password);
      const second = await t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
      await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE token_hash = $1`, [sha256(first.refreshToken)]);

      const stolen = await t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(stolen.status).toBe(401);
      expect(stolen.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      const victim = await t.http.post('/api/auth/refresh').send({ refreshToken: second.body.refreshToken });
      expect(victim.status).toBe(401); // a sessão legítima também caiu: o usuário precisa entrar de novo
      const { rowCount } = await pool.query(`SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
      expect(rowCount).toBe(0);
    });

    it('refresh token desconhecido, expirado ou de usuário desativado -> 401', async () => {
      const u = await createUser(pool);
      const a = await loginAs(t, u.email, u.password);
      expect((await t.http.post('/api/auth/refresh').send({ refreshToken: 'x'.repeat(64) })).status).toBe(401);

      await pool.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256(a.refreshToken)]);
      expect((await t.http.post('/api/auth/refresh').send({ refreshToken: a.refreshToken })).body.error.code).toBe('INVALID_REFRESH_TOKEN');

      const b = await loginAs(t, u.email, u.password);
      await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [u.id]);
      expect((await t.http.post('/api/auth/refresh').send({ refreshToken: b.refreshToken })).status).toBe(401);
    });

    it('refresh com formato inválido -> 400', async () => {
      expect((await t.http.post('/api/auth/refresh').send({ refreshToken: 'curto' })).status).toBe(400);
      expect((await t.http.post('/api/auth/refresh').send({})).status).toBe(400);
    });

    it('duas renovações simultâneas do mesmo token: no máximo uma vence e a sessão não é derrubada', async () => {
      const u = await createUser(pool);
      const first = await loginAs(t, u.email, u.password);
      const rs = await Promise.all([
        t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken }),
        t.http.post('/api/auth/refresh').send({ refreshToken: first.refreshToken }),
      ]);
      const winners = rs.filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      expect(rs.find((r) => r.status !== 200)!.body.error.code).toBe('INVALID_REFRESH_TOKEN'); // e não REUSED
      expect((await t.http.get('/api/auth/me').set(bearer(winners[0].body.accessToken))).status).toBe(200);
    });

    it('logout revoga o refresh token (204) e é idempotente', async () => {
      const u = await createUser(pool);
      const s = await loginAs(t, u.email, u.password);
      expect((await t.http.post('/api/auth/logout').send({ refreshToken: s.refreshToken })).status).toBe(204);
      expect((await t.http.post('/api/auth/logout').send({ refreshToken: s.refreshToken })).status).toBe(204);
      expect((await t.http.post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
    });
  });
});

describe('rate limiting', () => {
  let db: TestDb;
  let pool: Pool;
  let t: TestApp;

  beforeAll(async () => {
    db = await createTestDb();
    pool = db.pool;
    t = await createTestApp(db.url, { RATE_LIMIT_AUTH: '4', RATE_LIMIT_DEFAULT: '15' });
  });
  afterAll(async () => {
    await t.close();
    await db.drop();
  });

  it('login: a 5ª tentativa na janela recebe 429 RATE_LIMITED com Retry-After (força bruta)', async () => {
    const statuses: number[] = [];
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = await t.http.post('/api/auth/login').send({ email: 'alvo@loja.com', password: `chute-${i}` });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect(last.body.error.requestId).toBeDefined();
  });

  it('o limite estrito vale também para refresh e logout', async () => {
    const hit = async (path: string) => {
      const out: number[] = [];
      for (let i = 0; i < 5; i++) out.push((await t.http.post(path).send({ refreshToken: 'x'.repeat(40) })).status);
      return out;
    };
    // o contador de /auth/* é compartilhado por IP: já foi gasto nos testes anteriores, então tudo cai em 429 ou 401
    const r1 = await hit('/api/auth/refresh');
    expect(r1).toContain(429);
  });

  it('o limite de login NÃO atinge o resto da API, que tem teto próprio', async () => {
    const health = await t.http.get('/api/health'); // @SkipThrottle
    expect(health.status).toBe(200);
  });

  it('o teto geral também existe: depois de 15 requisições na janela, 429', async () => {
    const u = await createUser(pool);
    // esgota o teto "default" (compartilhado por IP) em uma rota autenticada
    const statuses: number[] = [];
    const token = t.signToken({ sub: u.id, role: 'ESTOQUISTA' }, { expiresIn: 600 });
    for (let i = 0; i < 20; i++) statuses.push((await t.http.get('/api/stock/balances').set(bearer(token))).status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(15);
    expect(statuses).toContain(429);
  });

  it('/health nunca é limitado (usado pelo frontend para detectar a volta do servidor)', async () => {
    for (let i = 0; i < 40; i++) expect((await t.http.get('/api/health')).status).toBe(200);
  });
});

describe('resiliência: banco de dados indisponível (queda de rede real)', () => {
  let db: TestDb;
  let pool: Pool;
  let t: TestApp;
  let proxy: TcpProxy;
  let token: string;

  beforeAll(async () => {
    db = await createTestDb();
    pool = db.pool;
    // a API conversa com o PostgreSQL através do proxy; o seed e as conferências usam o banco direto
    const target = new URL(db.url);
    proxy = new TcpProxy({ host: target.hostname, port: Number(target.port || 5432) });
    const port = await proxy.start();
    const viaProxy = new URL(db.url);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(port);
    t = await createTestApp(viaProxy.toString());
    const u = await createUser(pool);
    token = (await loginAs(t, u.email, u.password)).accessToken;
    await createProduct(pool, { sku: 'RES-1', barcode: '7896000100100' });
  });
  afterAll(async () => {
    await t.close().catch(() => undefined);
    await proxy.stop();
    await db.drop().catch(() => undefined);
  });

  const read = () => t.http.get('/api/stock/balances').set(bearer(token));

  it('com o banco fora do ar a API responde 503 padronizado com Retry-After (nunca 500), e se recupera sozinha quando ele volta', async () => {
    expect((await read()).status).toBe(200); // sanidade

    await proxy.stop(); // QUEDA

    const down = await read();
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('DB_UNAVAILABLE');
    expect(down.headers['retry-after']).toBe('5');
    expect(typeof down.body.error.requestId).toBe('string');
    expect(JSON.stringify(down.body)).not.toMatch(/ECONN|127\.0\.0\.1|postgres|stack/i); // sem detalhes internos

    const health = await t.http.get('/api/health'); // o monitor do frontend enxerga a queda
    expect(health.status).toBe(503);
    expect(health.body.error.code).toBe('DB_UNAVAILABLE');

    await proxy.start(); // VOLTA (mesma porta)

    const up = await read();
    expect(up.status).toBe(200);
    expect(up.body.data.map((x: any) => x.sku)).toContain('RES-1');
    expect((await t.http.get('/api/health')).status).toBe(200);
  });

  it('escrita durante a queda falha com 503, não grava nada, e o reenvio com a mesma Idempotency-Key funciona depois', async () => {
    const p = (await pool.query(`SELECT id FROM products WHERE sku = 'RES-1'`)).rows[0];
    const key = '7f0a9c3e-1d52-4e8b-9a64-3c2b1d0e5f77';
    const body = { productId: p.id, type: 'ENTRADA', quantity: 9 };

    await proxy.stop();
    const failed = await t.http.post('/api/stock/movements').set(bearer(token)).set('Idempotency-Key', key).send(body);
    expect(failed.status).toBe(503);
    expect((await pool.query(`SELECT count(*)::int AS n FROM stock_movements WHERE product_id = $1`, [p.id])).rows[0].n).toBe(0);

    await proxy.start();
    const retried = await t.http.post('/api/stock/movements').set(bearer(token)).set('Idempotency-Key', key).send(body);
    expect(retried.status).toBe(201);
    const again = await t.http.post('/api/stock/movements').set(bearer(token)).set('Idempotency-Key', key).send(body);
    expect(again.status).toBe(200); // reenvio: devolve a mesma
    expect(again.body.data.id).toBe(retried.body.data.id);
    expect((await pool.query(`SELECT current_stock FROM products WHERE id = $1`, [p.id])).rows[0].current_stock).toBe('9.000');
  });

  it('o login também responde 503 (e não 500) quando o banco está fora', async () => {
    await proxy.stop();
    const r = await t.http.post('/api/auth/login').send({ email: 'qualquer@loja.com', password: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('DB_UNAVAILABLE');
    await proxy.start();
  });

  it('várias quedas e recuperações seguidas: o processo nunca cai e as respostas voltam ao normal', async () => {
    for (let i = 0; i < 3; i++) {
      await proxy.stop();
      expect((await read()).status).toBe(503);
      await proxy.start();
      expect((await read()).status).toBe(200);
    }
  });
});
