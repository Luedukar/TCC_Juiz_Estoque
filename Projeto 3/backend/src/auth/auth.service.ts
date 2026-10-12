import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AppError } from '../common/app-error';
import type { Role } from '../common/types';
import { env } from '../config/env';
import { DatabaseService } from '../database/database.service';

interface Queryable {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

interface UserIdentity {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: UserIdentity;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// hash falso com o mesmo custo: login com e-mail inexistente leva o mesmo tempo que com senha errada
const DUMMY_HASH = bcrypt.hashSync('senha-falsa-para-equalizar-tempo', env.bcryptRounds);

// janela em que reutilizar um refresh token recém-rotacionado NÃO é tratado como roubo
// (requisições concorrentes / reenvio após timeout de rede)
const REUSE_GRACE_SECONDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string, meta: ClientMeta): Promise<TokenResponse> {
    const { rows } = await this.db.query(
      `SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];
    const passwordOk = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk || !user.is_active) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
    }

    const tokens = await this.issueTokens(this.db, user, meta);
    await this.db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    return tokens;
  }

  async refresh(rawToken: string, meta: ClientMeta): Promise<TokenResponse> {
    const outcome = await this.db.tx(null, async (c) => {
      const { rows } = await c.query(
        `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
                (rt.revoked_at > now() - make_interval(secs => $2)) AS recently_revoked,
                (rt.expires_at <= now()) AS expired,
                u.name, u.email, u.role, u.is_active
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
            FOR UPDATE OF rt`,
        [sha256(rawToken), REUSE_GRACE_SECONDS],
      );
      const row = rows[0];
      if (!row) return { kind: 'invalid' as const };

      if (row.revoked_at) {
        if (row.recently_revoked) return { kind: 'invalid' as const };
        // token antigo reapresentado: possível roubo -> revoga todas as sessões do usuário
        await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
          row.user_id,
        ]);
        return { kind: 'reused' as const };
      }
      if (row.expired || !row.is_active) return { kind: 'invalid' as const };

      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
      const tokens = await this.issueTokens(
        c,
        { id: row.user_id, name: row.name, email: row.email, role: row.role },
        meta,
      );
      return { kind: 'ok' as const, tokens };
    });

    // o throw fica fora da transação para que a revogação em massa seja confirmada (COMMIT)
    if (outcome.kind === 'reused') {
      throw new AppError(401, 'REFRESH_TOKEN_REUSED', 'Sessão encerrada por segurança. Faça login novamente.');
    }
    if (outcome.kind === 'invalid') {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Sessão inválida ou expirada. Faça login novamente.');
    }
    return outcome.tokens;
  }

  async logout(rawToken: string): Promise<void> {
    await this.db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
      sha256(rawToken),
    ]);
  }

  async me(userId: string): Promise<UserIdentity> {
    const { rows } = await this.db.query(`SELECT id, name, email, role, is_active FROM users WHERE id = $1`, [userId]);
    const u = rows[0];
    if (!u || !u.is_active) throw new AppError(401, 'INVALID_TOKEN', 'Usuário inativo ou inexistente.');
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  }

  private async issueTokens(q: Queryable, user: UserIdentity, meta: ClientMeta): Promise<TokenResponse> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const refreshToken = randomBytes(48).toString('base64url');
    await q.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
      [user.id, sha256(refreshToken), env.refreshTtlDays, meta.ip ?? null, meta.userAgent?.slice(0, 255) ?? null],
    );
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: env.accessTtlSeconds,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }
}
