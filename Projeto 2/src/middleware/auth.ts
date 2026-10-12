import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { user_role } from '../types';
import { HttpError } from '../errors';

declare global {
  namespace Express {
    interface Request { user?: { id: number; role: user_role } }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return next(new HttpError(401, 'Autenticação necessária.', 'UNAUTHENTICATED'));
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET ausente ou curto');
    const claims = jwt.verify(token, secret) as jwt.JwtPayload;
    if (!Number.isSafeInteger(claims.sub ? Number(claims.sub) : NaN) || !['MANAGER', 'STOCK_CLERK'].includes(String(claims.role))) {
      throw new Error('Claims inválidas');
    }
    req.user = { id: Number(claims.sub), role: claims.role as user_role };
    next();
  } catch {
    next(new HttpError(401, 'Token inválido ou expirado.', 'INVALID_TOKEN'));
  }
}

export function allowRoles(...roles: user_role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'Acesso não permitido.', 'FORBIDDEN'));
    next();
  };
}
