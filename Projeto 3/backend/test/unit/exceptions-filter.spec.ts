import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AllExceptionsFilter } from '../../src/common/all-exceptions.filter';
import { AppError } from '../../src/common/app-error';

function run(exception: unknown, headers: Record<string, string | number> = {}) {
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    headers: { ...headers } as Record<string, any>,
    headersSent: false,
    setHeader(k: string, v: any) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return this.headers[k.toLowerCase()];
    },
    getHeaders() {
      return this.headers;
    },
    status(s: number) {
      this.statusCode = s;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const req = { id: 'req-123', method: 'POST', originalUrl: '/api/x' };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return res;
}

describe('AllExceptionsFilter (formato único de erro)', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  it('AppError mantém status, código, mensagem e detalhes', () => {
    const res = run(new AppError(422, 'ALGO', 'mensagem clara', { campo: 1 }));
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'ALGO', message: 'mensagem clara', details: { campo: 1 }, requestId: 'req-123' });
    expect(typeof res.body.error.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.error.timestamp))).toBe(false);
  });

  it('omite "details" quando não há', () => {
    expect('details' in run(new AppError(400, 'X', 'y')).body.error).toBe(false);
  });

  it('ThrottlerException -> 429 RATE_LIMITED e promove o maior Retry-After-<nome> para Retry-After', () => {
    const res = run(new ThrottlerException(), { 'retry-after-default': 12, 'retry-after-auth': 40 });
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBe('40');
  });

  it('não sobrescreve um Retry-After já definido', () => {
    const res = run(new ThrottlerException(), { 'retry-after': 3, 'retry-after-auth': 40 });
    expect(res.headers['retry-after']).toBe(3);
  });

  it.each([
    [new ForbiddenException(), 403, 'FORBIDDEN'],
    [new NotFoundException(), 404, 'NOT_FOUND'],
  ])('HttpException padrão do Nest -> %#', (exception, status, code) => {
    const res = run(exception);
    expect(res.statusCode).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('HttpException 400 com lista de mensagens -> VALIDATION_ERROR com detalhes', () => {
    const res = run(new BadRequestException(['a deve ser número', 'b é obrigatório']));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: ['a deve ser número', 'b é obrigatório'] });
  });

  it('HttpException 400 de JSON malformado -> INVALID_JSON', () => {
    const res = run(new BadRequestException('Unexpected end of JSON input'));
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('HttpException 400 com mensagem simples -> BAD_REQUEST', () => {
    const res = run(new BadRequestException('mensagem específica'));
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'mensagem específica' });
  });

  it('erro do PostgreSQL passa pelo mapeamento (ex.: saldo insuficiente -> 422)', () => {
    const res = run({ code: 'ST001', message: 'ST001: estoque insuficiente (saldo 1, solicitado 2)' });
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', message: 'estoque insuficiente (saldo 1, solicitado 2)' });
  });

  it('banco indisponível -> 503 com Retry-After: 5, sem log de erro 500 vazando detalhes', () => {
    const res = run({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });

  it('erros do body-parser: payload grande -> 413; JSON inválido -> 400', () => {
    expect(run({ status: 413, type: 'entity.too.large' }).body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = run({ statusCode: 400, type: 'entity.parse.failed' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });

  it('outros 4xx desconhecidos mantêm o status', () => {
    const res = run({ status: 418 });
    expect(res.statusCode).toBe(418);
  });

  it('erro inesperado -> 500 genérico, sem expor a mensagem interna, e registra o erro', () => {
    const res = run(new Error('senha do banco = hunter2'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('valor lançado que nem é Error (string) também vira 500 padronizado', () => {
    const res = run('quebrou');
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});
