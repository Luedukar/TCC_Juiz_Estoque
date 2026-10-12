import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/** Atribui um requestId (aceita X-Request-Id válido do cliente) e registra um log por requisição. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (!env.logRequests) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms),
        userId: req.user?.id ?? null,
      }),
    );
  });
  next();
}
