import { createApp } from './app';
import { config } from './config';
import { pool } from './db';

const app = createApp(pool);
const server = app.listen(config.PORT, () => {
  console.info(`Inventory API listening on port ${config.PORT}`);
});

async function shutdown(signal: string) {
  console.info(`${signal} received; shutting down`);
  server.close(async (error) => {
    if (error) {
      console.error('HTTP server shutdown failed', error);
      process.exitCode = 1;
    }
    try {
      await pool.end();
    } catch (poolError) {
      console.error('Database pool shutdown failed', poolError);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
