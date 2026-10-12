import { ErrorRequestHandler } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_ERROR') {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error?.name === 'ZodError') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos.', details: error.issues } });
    return;
  }
  console.error(error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno do servidor.' } });
};
