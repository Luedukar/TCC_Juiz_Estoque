// Variáveis padrão para todo arquivo de teste (lidas por src/config/env.ts na importação).
// Testes que precisam de outros valores usam createTestApp(url, { CHAVE: 'valor' }).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-ok';
process.env.DATABASE_URL ??= 'postgres://estoque:estoque@localhost:5432/estoque_test_placeholder';
process.env.BCRYPT_ROUNDS = '4'; // hash rápido nos testes
process.env.LOG_REQUESTS = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.RATE_LIMIT_DEFAULT = '100000';
process.env.RATE_LIMIT_AUTH = '100000';
