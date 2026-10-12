import { mapPgError } from '../../src/common/pg-errors';

describe('mapPgError (SQLSTATE do banco -> erro HTTP padronizado)', () => {
  const cases: [string, number, string][] = [
    ['ST001', 422, 'INSUFFICIENT_STOCK'],
    ['ST002', 422, 'INVALID_REVERSAL'],
    ['ST003', 409, 'IMMUTABLE_RECORD'],
    ['ST004', 422, 'PRODUCT_UNAVAILABLE'],
    ['ST005', 500, 'INTERNAL_ERROR'],
    ['23505', 409, 'DUPLICATE'],
    ['23503', 422, 'REFERENCE_NOT_FOUND'],
    ['23514', 422, 'CONSTRAINT_VIOLATION'],
    ['23502', 422, 'CONSTRAINT_VIOLATION'],
    ['22P02', 400, 'INVALID_VALUE'],
    ['22003', 400, 'INVALID_VALUE'],
    ['40001', 503, 'RETRYABLE_CONFLICT'],
    ['40P01', 503, 'RETRYABLE_CONFLICT'],
    ['57014', 503, 'DB_TIMEOUT'],
    ['57P01', 503, 'DB_UNAVAILABLE'],
    ['57P03', 503, 'DB_UNAVAILABLE'],
    ['08006', 503, 'DB_UNAVAILABLE'],
    ['53300', 503, 'DB_UNAVAILABLE'], // too many connections
    ['53100', 503, 'DB_UNAVAILABLE'], // disco cheio
  ];

  it.each(cases)('SQLSTATE %s -> %i %s', (code, status, mapped) => {
    expect(mapPgError({ code, message: 'x' })).toMatchObject({ status, code: mapped });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'])('erro de rede %s -> 503 DB_UNAVAILABLE', (code) => {
    expect(mapPgError({ code, message: 'x' })).toMatchObject({ status: 503, code: 'DB_UNAVAILABLE' });
  });

  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'the database system is starting up',
    'the database system is shutting down',
  ])('mensagem "%s" -> 503 DB_UNAVAILABLE', (message) => {
    expect(mapPgError(new Error(message))).toMatchObject({ status: 503, code: 'DB_UNAVAILABLE' });
  });

  it('remove o prefixo "STxxx:" da mensagem mostrada ao usuário', () => {
    const r = mapPgError({ code: 'ST001', message: 'ST001: estoque insuficiente (saldo 3, solicitado 9)' });
    expect(r?.message).toBe('estoque insuficiente (saldo 3, solicitado 9)');
  });

  it('não mapeia erros que não são do banco nem SQLSTATE desconhecido', () => {
    expect(mapPgError(null)).toBeNull();
    expect(mapPgError('texto')).toBeNull();
    expect(mapPgError(new Error('qualquer coisa'))).toBeNull();
    expect(mapPgError({ code: '99999', message: 'x' })).toBeNull();
    expect(mapPgError({ code: 'abc', message: 'x' })).toBeNull();
  });
});
