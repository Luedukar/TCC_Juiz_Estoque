import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AppError } from '../common/app-error';
import { ROLES, Role } from '../common/types';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Token de acesso ausente.');
    }

    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; role?: Role }>(token);
      if (!payload.sub || !payload.role || !ROLES.includes(payload.role)) {
        throw new AppError(401, 'INVALID_TOKEN', 'Token inválido.');
      }
      req.user = { id: payload.sub, role: payload.role };
      return true;
    } catch (err) {
      if (err instanceof AppError) throw err;
      // o frontend usa TOKEN_EXPIRED para disparar o refresh silencioso
      if ((err as Error).name === 'TokenExpiredError') {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Token expirado.');
      }
      throw new AppError(401, 'INVALID_TOKEN', 'Token inválido.');
    }
  }
}
