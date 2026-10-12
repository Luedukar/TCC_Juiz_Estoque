import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppError } from './app-error';
import { mapPgError } from './pg-errors';

interface Normalized {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

const BY_STATUS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Requisição inválida.' },
  401: { code: 'UNAUTHENTICATED', message: 'Autenticação necessária.' },
  403: { code: 'FORBIDDEN', message: 'Você não tem permissão para esta ação.' },
  404: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Corpo da requisição grande demais.' },
  429: { code: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um instante e tente novamente.' },
};

/**
 * Todo erro da API sai neste formato:
 * { "error": { "code", "message", "details"?, "requestId", "timestamp" } }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const n = this.normalize(exception);

    if (n.status >= 500) {
      this.logger.error(
        `[${req.id}] ${req.method} ${req.originalUrl} -> ${n.status} ${n.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (n.status === 503 && !res.headersSent) res.setHeader('Retry-After', '5');
    if (n.status === 429 && !res.headersSent && !res.getHeader('retry-after')) {
      // o Throttler publica "Retry-After-<nome>" por limite nomeado; expomos o padrão "Retry-After"
      const waits = Object.entries(res.getHeaders())
        .filter(([k]) => k.startsWith('retry-after-'))
        .map(([, v]) => Number(v))
        .filter(Number.isFinite);
      if (waits.length) res.setHeader('Retry-After', String(Math.max(...waits)));
    }

    res.status(n.status).json({
      error: {
        code: n.code,
        message: n.message,
        ...(n.details !== undefined ? { details: n.details } : {}),
        requestId: req.id,
        timestamp: new Date().toISOString(),
      },
    });
  }

  private normalize(e: unknown): Normalized {
    if (e instanceof AppError) {
      return { status: e.getStatus(), code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof ThrottlerException) {
      return { status: 429, ...BY_STATUS[429] };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const fallback = BY_STATUS[status] ?? { code: 'HTTP_ERROR', message: e.message };
      const body = e.getResponse();
      const raw = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
      if (Array.isArray(raw)) {
        return { status, code: 'VALIDATION_ERROR', message: 'Dados inválidos.', details: raw };
      }
      if (status === 400 && typeof raw === 'string') {
        if (/JSON/i.test(raw)) {
          return { status, code: 'INVALID_JSON', message: 'JSON inválido no corpo da requisição.' };
        }
        return { status, code: 'BAD_REQUEST', message: raw };
      }
      return { status, ...fallback };
    }

    const pg = mapPgError(e);
    if (pg) return pg;

    // erros do body-parser (JSON malformado, payload grande)
    const anyErr = e as { status?: unknown; statusCode?: unknown; type?: unknown };
    const s = typeof anyErr?.status === 'number' ? anyErr.status : anyErr?.statusCode;
    if (typeof s === 'number' && s >= 400 && s < 500) {
      if (anyErr.type === 'entity.too.large') return { status: 413, ...BY_STATUS[413] };
      if (anyErr.type === 'entity.parse.failed') {
        return { status: 400, code: 'INVALID_JSON', message: 'JSON inválido no corpo da requisição.' };
      }
      return { status: s, ...(BY_STATUS[s] ?? { code: 'BAD_REQUEST', message: 'Requisição inválida.' }) };
    }

    return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno inesperado.' };
  }
}
