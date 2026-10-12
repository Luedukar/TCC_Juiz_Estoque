import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../common/app-error';
import type { Role } from '../common/types';
import { IS_PUBLIC } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (!required || required.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user || !required.includes(user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para esta ação.');
    }
    return true;
  }
}
