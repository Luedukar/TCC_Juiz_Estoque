import { EventEmitter } from 'node:events';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
  jest.dontMock('pg');
});

function loadEnv(vars: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod: typeof import('../../src/config/env');
  jest.isolateModules(() => {
    mod = require('../../src/config/env');
  });
  return mod!.env;
}

describe('configuração (env.ts): falha rápido e com mensagem clara', () => {
  it('lê os valores padrão e converte tipos', () => {
    const env = loadEnv({ PORT: '4000', PG_POOL_MAX: '20', CORS_ORIGINS: 'http://a.com, http://b.com ,', DATABASE_SSL: 'true' });
    expect(env).toMatchObject({ port: 4000, pgPoolMax: 20, databaseSsl: true, corsOrigins: ['http://a.com', 'http://b.com'] });
    expect(env.accessTtlSeconds).toBe(900);
    expect(env.refreshTtlDays).toBe(7);
  });

  it('DATABASE_URL ausente impede a subida', () => {
    expect(() => loadEnv({ DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('JWT_SECRET ausente ou curto (< 32 caracteres) impede a subida', () => {
    expect(() => loadEnv({ JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ JWT_SECRET: 'curto' })).toThrow(/32 caracteres/);
  });

  it.each(['abc', '-1', '1.5'])('valor numérico inválido (%s) é recusado', (bad) => {
    expect(() => loadEnv({ RATE_LIMIT_AUTH: bad })).toThrow(/RATE_LIMIT_AUTH/);
  });

  it('valor numérico vazio usa o padrão', () => {
    expect(loadEnv({ RATE_LIMIT_AUTH: '' }).rateLimitAuth).toBe(10);
  });

  it.each([
    ['false', false],
    ['', false],
    ['true', true],
    ['1', 1],
    ['10.0.0.0/8', '10.0.0.0/8'],
  ])('TRUST_PROXY=%p -> %p (atrás de balanceador o rate limit enxerga o IP real)', (raw, expected) => {
    expect(loadEnv({ TRUST_PROXY: raw }).trustProxy).toBe(expected);
  });

  it('LOG_REQUESTS: ligado por padrão fora de teste, desligado em teste, e configurável', () => {
    expect(loadEnv({ NODE_ENV: 'production', LOG_REQUESTS: undefined }).logRequests).toBe(true);
    expect(loadEnv({ NODE_ENV: 'test', LOG_REQUESTS: undefined }).logRequests).toBe(false);
    expect(loadEnv({ LOG_REQUESTS: 'false' }).logRequests).toBe(false);
  });
});

describe('request-context: requestId e log por requisição', () => {
  function run(headers: Record<string, string>, logRequests: 'true' | 'false') {
    process.env.LOG_REQUESTS = logRequests;
    let mod: typeof import('../../src/common/request-context');
    jest.isolateModules(() => {
      mod = require('../../src/common/request-context');
    });
    const res: any = new EventEmitter();
    res.headers = {} as Record<string, string>;
    res.statusCode = 201;
    res.setHeader = (k: string, v: string) => (res.headers[k.toLowerCase()] = v);
    const req: any = { header: (n: string) => headers[n.toLowerCase()], method: 'POST', originalUrl: '/api/stock/movements?x=1', user: { id: 'u1' } };
    const next = jest.fn();
    mod!.requestContext(req, res, next);
    return { req, res, next };
  }

  it('gera um UUID quando o cliente não envia X-Request-Id, e devolve no cabeçalho', () => {
    const { req, res, next } = run({}, 'false');
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(req.id);
    expect(next).toHaveBeenCalled();
  });

  it('aceita o X-Request-Id do cliente se tiver formato seguro; descarta valores suspeitos (injeção em log)', () => {
    expect(run({ 'x-request-id': 'front-req-12345678' }, 'false').req.id).toBe('front-req-12345678');
    const evil = run({ 'x-request-id': 'a\nb: injetado' }, 'false').req.id;
    expect(evil).toMatch(/^[0-9a-f-]{36}$/);
    expect(run({ 'x-request-id': 'curto' }, 'false').req.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('com LOG_REQUESTS=true escreve UMA linha JSON por requisição, sem query string nem dados sensíveis', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { res, req } = run({}, 'true');
    res.emit('finish');
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ requestId: req.id, method: 'POST', path: '/api/stock/movements', status: 201, userId: 'u1' });
    expect(typeof line.ms).toBe('number');
    expect(JSON.stringify(line)).not.toContain('x=1');
    spy.mockRestore();
  });

  it('com LOG_REQUESTS=false não escreve nada', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    run({}, 'false').res.emit('finish');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('DatabaseService.tx: transação e conexões', () => {
  function load(client: any) {
    const pool: any = new EventEmitter();
    pool.connect = jest.fn().mockResolvedValue(client);
    pool.query = jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] });
    pool.end = jest.fn().mockResolvedValue(undefined);
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
    const { DatabaseService } = require('../../src/database/database.service');
    return { service: new DatabaseService(), pool };
  }

  const makeClient = (failOn?: RegExp) => ({
    query: jest.fn(async (sql: string) => {
      if (failOn && failOn.test(sql)) throw new Error(`falhou: ${sql}`);
      return { rows: [] };
    }),
    release: jest.fn(),
  });

  it('BEGIN, define o usuário da auditoria (set_config local), COMMIT e devolve a conexão', async () => {
    const client = makeClient();
    const { service } = load(client);
    const out = await service.tx('user-1', async () => 'resultado');
    expect(out).toBe('resultado');
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/set_config\('app.current_user_id', \$1, true\)/);
    expect((client.query.mock.calls[1] as any[])[1]).toEqual(['user-1']);
    expect(sqls[2]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('sem usuário, o contexto fica vazio (nunca herda o de outra requisição)', async () => {
    const client = makeClient();
    const { service } = load(client);
    await service.tx(null, async () => undefined);
    expect((client.query.mock.calls[1] as any[])[1]).toEqual(['']);
  });

  it('erro dentro da transação: ROLLBACK, propaga o erro original e devolve a conexão ao pool', async () => {
    const client = makeClient();
    const { service } = load(client);
    const boom = new Error('boom');
    await expect(service.tx('u', async () => { throw boom; })).rejects.toBe(boom);
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('se o ROLLBACK também falhar (conexão morta), a conexão é DESCARTADA em vez de reaproveitada', async () => {
    const client = makeClient(/ROLLBACK/);
    const { service } = load(client);
    const boom = new Error('boom');
    await expect(service.tx('u', async () => { throw boom; })).rejects.toBe(boom); // o erro original não é mascarado
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('erro de conexão ociosa no pool é registrado e NÃO derruba o processo', () => {
    const { pool } = load(makeClient());
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
  });

  it('encerra o pool ao desligar a aplicação', async () => {
    const { service, pool } = load(makeClient());
    await service.onModuleDestroy();
    expect(pool.end).toHaveBeenCalled();
  });
});
