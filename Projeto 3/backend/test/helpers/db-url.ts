export const TEMPLATE_DB = 'estoque_test_template';

/**
 * URL de um usuário que pode criar bancos (ex.: postgres://usuario:senha@localhost:5432/postgres).
 * Cada arquivo de teste recebe seu próprio banco, clonado de um template já com o schema.sql aplicado.
 */
export function adminUrl(): string {
  return process.env.TEST_DATABASE_URL ?? 'postgres://estoque:estoque@localhost:5432/postgres';
}

export function withDb(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
