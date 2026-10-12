import { ApiError, NetworkError } from './http';

export interface DescribedError {
  message: string;
  /** Falha de conexão (e não recusa do servidor). */
  network: boolean;
}

/** Texto para o usuário: diz o que houve e o que fazer. */
export function describeError(e: unknown): DescribedError {
  if (e instanceof NetworkError) {
    const message =
      e.kind === 'timeout'
        ? 'O servidor demorou demais para responder.'
        : e.kind === 'offline'
          ? 'Este aparelho está sem internet.'
          : e.kind === 'unavailable'
            ? 'O servidor está indisponível no momento.'
            : 'Não foi possível conectar ao servidor.';
    return { message, network: true };
  }
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'RATE_LIMITED':
        return { message: `Muitas tentativas seguidas. Aguarde ${e.retryAfter ?? 60} segundos e tente de novo.`, network: false };
      case 'INVALID_CREDENTIALS':
        return { message: 'E-mail ou senha incorretos.', network: false };
      case 'VALIDATION_ERROR':
        return { message: 'Confira os campos informados.', network: false };
      case 'FORBIDDEN':
      case 'FORBIDDEN_FIELD':
        return { message: 'Seu perfil não permite esta ação.', network: false };
      case 'TOKEN_EXPIRED':
      case 'INVALID_TOKEN':
      case 'UNAUTHENTICATED':
        return { message: 'Sua sessão expirou. Entre novamente.', network: false };
      default:
        return { message: e.message, network: false };
    }
  }
  return { message: 'Algo deu errado. Tente novamente.', network: false };
}
