import { ExecutionContext, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { env } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { StockModule } from './stock/stock.module';

const isAuthRoute = (ctx: ExecutionContext) =>
  /\/auth\/(login|refresh|logout)\/?$/.test(ctx.switchToHttp().getRequest<Request>().path);

@Module({
  imports: [
    // Rate limiting por IP, janela de 60 s:
    //  - "default": teto geral generoso para toda a API;
    //  - "auth":    teto estrito só nos endpoints públicos de autenticação (força bruta).
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ttl: 60_000, limit: env.rateLimitDefault },
        { name: 'auth', ttl: 60_000, limit: env.rateLimitAuth, skipIf: (ctx) => !isAuthRoute(ctx) },
      ],
    }),
    DatabaseModule,
    AuthModule,
    StockModule,
  ],
  controllers: [HealthController],
  providers: [
    // a ordem importa: rate limit -> autenticação (JWT) -> autorização (perfil)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
