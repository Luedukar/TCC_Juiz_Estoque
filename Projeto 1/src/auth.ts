import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Pool } from 'pg';
import { config } from './config';
import { ApiError } from './errors';

export type UserRole = 'manager' | 'stockist';

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; role: UserRole };
}

export function authenticate(pool: Pool) {
  return async (
    request: AuthenticatedRequest,
    _response: Response,
    next: NextFunction
  ): Promise<void> => {
  const authorization = request.header('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    return;
  }

  try {
    const decoded = jwt.verify(match[1], config.JWT_SECRET, {
      issuer: 'inventory-control-api',
      audience: 'inventory-control'
    });
    if (typeof decoded === 'string' || typeof decoded.userId !== 'string') {
      throw new ApiError(401, 'INVALID_TOKEN', 'Authentication token is invalid');
    }

    const result = await pool.query(
      'SELECT role FROM users WHERE id = $1 AND active = TRUE',
      [decoded.userId]
    );
    const role = result.rows[0]?.role;
    if (role !== 'manager' && role !== 'stockist') {
      throw new ApiError(401, 'UNAUTHENTICATED', 'User is inactive or no longer exists');
    }
    request.auth = { userId: decoded.userId, role };
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      next(error);
      return;
    }
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      next(new ApiError(401, 'INVALID_TOKEN', 'Authentication token is invalid or expired'));
      return;
    }
    next(error);
  }
    };
}

export function requireManager(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction
): void {
  if (!request.auth) {
    next(new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    return;
  }
  if (request.auth.role !== 'manager') {
    next(new ApiError(403, 'FORBIDDEN', 'Manager access is required'));
    return;
  }
  next();
}

export function signAccessToken(user: { id: string }): string {
  return jwt.sign(
    { userId: user.id } satisfies JwtPayload,
    config.JWT_SECRET,
    { expiresIn: '8h', issuer: 'inventory-control-api', audience: 'inventory-control' }
  );
}
