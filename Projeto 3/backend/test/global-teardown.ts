import { Client } from 'pg';
import { adminUrl } from './helpers/db-url';

/** Remove o template e qualquer banco de teste que tenha sobrado. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.SKIP_DB_SETUP) return;
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'estoque\\_test\\_%'`);
    for (const { datname } of rows) await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
