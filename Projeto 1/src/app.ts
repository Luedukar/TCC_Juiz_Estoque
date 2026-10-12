import bcrypt from 'bcryptjs';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest, signAccessToken } from './auth';
import { ApiError } from './errors';
import { calculateNextBalance, StockBalanceError } from './inventory';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});

const movementSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number()
    .positive()
    .finite()
    .max(1_000_000_000),
  reason: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(120).optional()
});

const reversalSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

const uuidSchema = z.string().uuid();
type MovementKind = 'in' | 'out';

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

function requestUser(request: AuthenticatedRequest) {
  if (!request.auth) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  return request.auth;
}

function mapDatabaseError(error: unknown): never {
  if (typeof error !== 'object' || error === null) {
    throw error;
  }
  const databaseError = error as { code?: string; message?: string };
  if (databaseError.code === '23514' && databaseError.message?.includes('Insufficient stock')) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock for this movement');
  }
  if (databaseError.code === '23514') {
    throw new ApiError(422, 'INVALID_MOVEMENT', 'Movement violates an inventory rule');
  }
  if (databaseError.code === '23503') {
    throw new ApiError(404, 'RELATED_RECORD_NOT_FOUND', 'Related inventory record was not found');
  }
  if (databaseError.code === '23505') {
    throw new ApiError(409, 'MOVEMENT_ALREADY_REVERSED', 'This movement has already been reversed');
  }
  throw error;
}

function validateBalance(currentQuantity: string, type: MovementKind, quantity: number): void {
  try {
    calculateNextBalance(Number(currentQuantity), type, quantity);
  } catch (error) {
    if (error instanceof StockBalanceError) {
      const status = error.code === 'INSUFFICIENT_STOCK' ? 409 : 400;
      throw new ApiError(status, error.code, error.message);
    }
    throw error;
  }
}

async function insertMovement(
  client: PoolClient,
  values: {
    productId: string;
    userId: string;
    type: MovementKind;
    quantity: number;
    reason?: string;
    reference?: string;
    reversalOfId?: string;
  }
) {
  try {
    const result = await client.query(
      `INSERT INTO stock_movements
         (product_id, user_id, type, quantity, reason, reference, reversal_of_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, product_id AS "productId", user_id AS "userId",
                 type, quantity, reason, reference,
                 reversal_of_id AS "reversalOfId", occurred_at AS "occurredAt"`,
      [
        values.productId,
        values.userId,
        values.type,
        values.quantity,
        values.reason ?? null,
        values.reference ?? null,
        values.reversalOfId ?? null
      ]
    );
    return result.rows[0];
  } catch (error) {
    mapDatabaseError(error);
  }
}

export function createApp(pool: Pool) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many login attempts; try again later' }
    }
  });

  app.post('/api/auth/login', loginLimiter, asyncRoute(async (request, response) => {
    const input = loginSchema.safeParse(request.body);
    if (!input.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Email or password format is invalid');
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash AS "passwordHash", role
         FROM users
        WHERE lower(email) = lower($1) AND active = TRUE`,
      [input.data.email]
    );
    const user = result.rows[0] as
      | { id: string; name: string; email: string; passwordHash: string; role: 'manager' | 'stockist' }
      | undefined;

    if (!user || !(await bcrypt.compare(input.data.password, user.passwordHash))) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    response.json({
      data: {
        accessToken: signAccessToken(user),
        tokenType: 'Bearer',
        expiresIn: 28800,
        user: { id: user.id, name: user.name, email: user.email, role: user.role }
      }
    });
  }));

  app.get('/api/auth/me', authenticate(pool), asyncRoute(async (request, response) => {
    const auth = requestUser(request as AuthenticatedRequest);
    const result = await pool.query(
      `SELECT id, name, email, role FROM users WHERE id = $1 AND active = TRUE`,
      [auth.userId]
    );
    if (!result.rowCount) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'User is inactive or no longer exists');
    }
    response.json({ data: result.rows[0] });
  }));

  app.post('/api/movements', authenticate(pool), asyncRoute(async (request, response) => {
    const user = requestUser(request as AuthenticatedRequest);
    const input = movementSchema.safeParse(request.body);
    if (!input.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Movement payload is invalid');
    }
    const kind = request.query.type;
    if (kind !== 'in' && kind !== 'out') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Query parameter type must be in or out');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const product = await client.query(
        'SELECT id FROM products WHERE id = $1 AND active = TRUE FOR SHARE',
        [input.data.productId]
      );
      if (!product.rowCount) {
        throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Active product was not found');
      }
      const balance = await client.query(
        'SELECT quantity FROM stock_balances WHERE product_id = $1 FOR UPDATE',
        [input.data.productId]
      );
      if (!balance.rowCount) {
        throw new ApiError(404, 'BALANCE_NOT_FOUND', 'Stock balance was not found');
      }
      validateBalance(balance.rows[0].quantity, kind, input.data.quantity);
      const movement = await insertMovement(client, {
        ...input.data,
        userId: user.userId,
        type: kind
      });
      await client.query('COMMIT');
      response.status(201).json({ data: movement });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post('/api/movements/:id/reversal', authenticate(pool), asyncRoute(async (request, response) => {
    const user = requestUser(request as AuthenticatedRequest);
    const movementId = uuidSchema.safeParse(request.params.id);
    const input = reversalSchema.safeParse(request.body ?? {});
    if (!movementId.success || !input.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Reversal request is invalid');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const originalResult = await client.query(
        `SELECT id, product_id AS "productId", type, quantity, reversal_of_id AS "reversalOfId"
           FROM stock_movements WHERE id = $1 FOR UPDATE`,
        [movementId.data]
      );
      const original = originalResult.rows[0] as
        | { id: string; productId: string; type: MovementKind; quantity: string; reversalOfId: string | null }
        | undefined;
      if (!original) {
        throw new ApiError(404, 'MOVEMENT_NOT_FOUND', 'Movement was not found');
      }
      if (original.reversalOfId) {
        throw new ApiError(409, 'INVALID_REVERSAL', 'A reversal cannot itself be reversed');
      }
      const balance = await client.query(
        'SELECT quantity FROM stock_balances WHERE product_id = $1 FOR UPDATE',
        [original.productId]
      );
      if (!balance.rowCount) {
        throw new ApiError(404, 'BALANCE_NOT_FOUND', 'Stock balance was not found');
      }
      const reversalType = original.type === 'in' ? 'out' : 'in';
      const reversalQuantity = Number(original.quantity);
      validateBalance(balance.rows[0].quantity, reversalType, reversalQuantity);
      const reversal = await insertMovement(client, {
        productId: original.productId,
        userId: user.userId,
        type: reversalType,
        quantity: reversalQuantity,
        reason: input.data.reason ?? `Reversal of movement ${original.id}`,
        reversalOfId: original.id
      });
      await client.query('COMMIT');
      response.status(201).json({ data: reversal });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get('/api/products/:id/balance', authenticate(pool), asyncRoute(async (request, response) => {
    const productId = uuidSchema.safeParse(request.params.id);
    if (!productId.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Product id must be a UUID');
    }
    const result = await pool.query(
      `SELECT p.id AS "productId", p.sku, p.name, b.quantity, b.updated_at AS "updatedAt"
         FROM products p
         JOIN stock_balances b ON b.product_id = p.id
        WHERE p.id = $1 AND p.active = TRUE`,
      [productId.data]
    );
    if (!result.rowCount) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Active product was not found');
    }
    response.json({ data: result.rows[0] });
  }));

  app.get('/api/products/:id/kardex', authenticate(pool), asyncRoute(async (request, response) => {
    const productId = uuidSchema.safeParse(request.params.id);
    const limit = z.coerce.number().int().min(1).max(200).default(50).safeParse(request.query.limit);
    const offset = z.coerce.number().int().min(0).default(0).safeParse(request.query.offset);
    if (!productId.success || !limit.success || !offset.success) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Kardex query is invalid');
    }

    const result = await pool.query(
      `SELECT m.id, m.product_id AS "productId", m.type, m.quantity, m.reason,
              m.reference, m.reversal_of_id AS "reversalOfId",
              m.occurred_at AS "occurredAt", u.id AS "userId", u.name AS "userName"
         FROM stock_movements m
         JOIN users u ON u.id = m.user_id
        WHERE m.product_id = $1
        ORDER BY m.occurred_at DESC, m.id DESC
        LIMIT $2 OFFSET $3`,
      [productId.data, limit.data, offset.data]
    );
    response.json({ data: result.rows, pagination: { limit: limit.data, offset: offset.data } });
  }));

  app.get('/api/inventory/low-stock', authenticate(pool), asyncRoute(async (_request, response) => {
    const result = await pool.query(
      `SELECT id, sku, barcode, name, quantity, safety_stock
         FROM low_stock_products ORDER BY name`
    );
    response.json({ data: result.rows });
  }));

  app.use((_request, _response, next) => {
    next(new ApiError(404, 'NOT_FOUND', 'Route was not found'));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message }
      });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Request body contains invalid JSON' }
      });
      return;
    }
    console.error('Unhandled API error', error);
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
    });
  });

  return app;
}
