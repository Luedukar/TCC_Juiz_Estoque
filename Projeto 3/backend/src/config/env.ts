import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Valor inválido para ${name}: ${raw}`);
  return n;
}

function parseTrustProxy(raw: string): boolean | number | string {
  if (raw === 'false' || raw === '') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // lista de IPs/CIDRs aceita pelo Express
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  pgPoolMax: int('PG_POOL_MAX', 10),
  jwtSecret,
  accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 900),
  refreshTtlDays: int('REFRESH_TTL_DAYS', 7),
  bcryptRounds: int('BCRYPT_ROUNDS', 12),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? 'false'),
  rateLimitDefault: int('RATE_LIMIT_DEFAULT', 120),
  rateLimitAuth: int('RATE_LIMIT_AUTH', 10),
  logRequests: (process.env.LOG_REQUESTS ?? (process.env.NODE_ENV === 'test' ? 'false' : 'true')) === 'true',
};
