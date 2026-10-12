import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: env.databaseUrl,
      max: env.pgPoolMax,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      ssl: env.databaseSsl ? { rejectUnauthorized: true } : undefined,
    });
    // sem este handler, uma conexão ociosa derrubada pelo servidor derruba o processo
    this.pool.on('error', (err) => this.logger.error(`Erro em conexão ociosa do pool: ${err.message}`));
  }

  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /**
   * Executa `fn` em uma transação. O usuário autenticado é registrado em
   * `app.current_user_id` (escopo da transação) para a auditoria do banco.
   */
  async tx<T>(userId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId ?? '']);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // conexão inutilizável: descarta em vez de devolver ao pool
      }
      throw err;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
