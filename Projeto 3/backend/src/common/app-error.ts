import { HttpException } from '@nestjs/common';

/**
 * Erro de negócio/aplicação com código estável (para o frontend decidir o que fazer)
 * e mensagem legível em português.
 */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, status);
  }
}
