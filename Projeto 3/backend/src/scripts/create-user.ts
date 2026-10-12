/**
 * Cria um usuário (use para o primeiro GERENTE).
 *   NEW_USER_PASSWORD='uma-senha-forte' npm run user:create -- gerente@loja.com "Maria Silva" GERENTE
 * A senha vem de variável de ambiente (não aparece no histórico do shell nem na lista de processos).
 */
import 'dotenv/config';
import * as bcrypt from 'bcryptjs';
import { Pool } from 'pg';

async function main() {
  const [email, name, role = 'ESTOQUISTA'] = process.argv.slice(2);
  const password = process.env.NEW_USER_PASSWORD;

  if (!email || !name || !password) {
    throw new Error('Uso: NEW_USER_PASSWORD=... npm run user:create -- <email> "<nome>" [GERENTE|ESTOQUISTA]');
  }
  if (!['GERENTE', 'ESTOQUISTA'].includes(role)) throw new Error('Perfil deve ser GERENTE ou ESTOQUISTA');
  if (password.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não definida');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS ?? 12));
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, email, hash, role],
    );
    console.log(`Usuário criado: ${rows[0].id} (${role})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
