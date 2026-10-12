import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { adminUrl, TEMPLATE_DB, withDb } from './helpers/db-url';

/** Cria (uma vez por execução) o banco-template com o schema.sql aplicado. */
export default async function globalSetup(): Promise<void> {
  if (process.env.SKIP_DB_SETUP) return; // testes unitários puros não precisam de banco

  const admin = new Client({ connectionString: adminUrl() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Não foi possível conectar ao PostgreSQL em ${adminUrl()}.\n` +
        `Suba o banco ou defina TEST_DATABASE_URL (usuário com permissão CREATEDB). Detalhe: ${(err as Error).message}`,
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  const template = new Client({ connectionString: withDb(adminUrl(), TEMPLATE_DB) });
  await template.connect();
  try {
    await template.query(readFileSync(path.join(__dirname, '..', '..', 'docs', 'schema.sql'), 'utf8'));
  } finally {
    await template.end();
  }
}
