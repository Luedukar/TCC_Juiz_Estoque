import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof supertest>;
  close: () => Promise<void>;
  /** Assina um JWT com o segredo da aplicação (para testar tokens sem passar pelo login). */
  signToken: (payload: Record<string, unknown>, options?: Record<string, unknown>) => string;
}

/**
 * Sobe a aplicação NestJS real (mesma configuração do main.ts) apontando para `databaseUrl`.
 * As variáveis em `envOverrides` valem para esta instância; os módulos são recarregados para
 * que src/config/env.ts leia os valores novos.
 */
export async function createTestApp(databaseUrl: string, envOverrides: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, { DATABASE_URL: databaseUrl, ...envOverrides });
  jest.resetModules();

  // require (e não import()): após jest.resetModules() os módulos são recarregados com o ambiente novo
  const { NestFactory } = require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = require('../../src/app.module') as typeof import('../../src/app.module');
  const { configureApp } = require('../../src/app.setup') as typeof import('../../src/app.setup');

  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  configureApp(app);
  await app.init();

  const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
  return {
    app,
    http: supertest(app.getHttpServer()),
    close: () => app.close(),
    signToken: (payload, options) =>
      jwt.sign(payload, process.env.JWT_SECRET as string, { algorithm: 'HS256', ...(options as object) }),
  };
}

export async function loginAs(t: TestApp, email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await t.http.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login falhou (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
