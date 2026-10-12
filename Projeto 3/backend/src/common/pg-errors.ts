export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);

function stripPrefix(message: string): string {
  return message.replace(/^ST\d{3}:\s*/, '');
}

/**
 * Traduz erros do PostgreSQL (inclusive os SQLSTATEs ST001..ST005 definidos no schema.sql)
 * em respostas HTTP padronizadas. Retorna null se o erro não for do banco.
 */
export function mapPgError(err: unknown): MappedError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; message?: string };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  if (code && NETWORK_CODES.has(code)) {
    return { status: 503, code: 'DB_UNAVAILABLE', message: 'Banco de dados indisponível. Tente novamente em instantes.' };
  }
  if (/timeout exceeded when trying to connect|Connection terminated|the database system is (starting up|shutting down)/i.test(message)) {
    return { status: 503, code: 'DB_UNAVAILABLE', message: 'Banco de dados indisponível. Tente novamente em instantes.' };
  }
  if (!code || !/^[0-9A-Z]{5}$/.test(code)) return null;

  switch (code) {
    case 'ST001':
      return { status: 422, code: 'INSUFFICIENT_STOCK', message: stripPrefix(message) };
    case 'ST002':
      return { status: 422, code: 'INVALID_REVERSAL', message: stripPrefix(message) };
    case 'ST003':
      return { status: 409, code: 'IMMUTABLE_RECORD', message: stripPrefix(message) };
    case 'ST004':
      return { status: 422, code: 'PRODUCT_UNAVAILABLE', message: stripPrefix(message) };
    case 'ST005':
      return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno inesperado.' };
    case '23505':
      return { status: 409, code: 'DUPLICATE', message: 'Registro duplicado.' };
    case '23503':
      return { status: 422, code: 'REFERENCE_NOT_FOUND', message: 'Registro relacionado inexistente.' };
    case '23514':
    case '23502':
      return { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'Dados violam uma regra de integridade.' };
    case '22P02':
    case '22003':
    case '22007':
    case '22008':
      return { status: 400, code: 'INVALID_VALUE', message: 'Valor inválido.' };
    case '40001':
    case '40P01':
      return { status: 503, code: 'RETRYABLE_CONFLICT', message: 'Conflito de concorrência. Tente novamente.' };
    case '57014':
      return { status: 503, code: 'DB_TIMEOUT', message: 'A operação demorou demais. Tente novamente.' };
    case '57P01':
    case '57P03':
      return { status: 503, code: 'DB_UNAVAILABLE', message: 'Banco de dados indisponível. Tente novamente em instantes.' };
    default:
      if (code.startsWith('08') || code.startsWith('53')) {
        return { status: 503, code: 'DB_UNAVAILABLE', message: 'Banco de dados indisponível. Tente novamente em instantes.' };
      }
      return null;
  }
}
