import type { User } from './types';

/**
 * Sessão em memória + refresh token em sessionStorage.
 *  - access token (15 min): só em memória, some ao recarregar a página;
 *  - refresh token: sessionStorage (some ao fechar a aba). Evita persistência longa no aparelho
 *    compartilhado do balcão; o custo é logar de novo ao reabrir o navegador.
 */
const REFRESH_KEY = 'estoque.refresh';

let accessToken: string | null = null;
let user: User | null = null;
const listeners = new Set<() => void>();
const expiredListeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const session = {
  getAccessToken: () => accessToken,
  getUser: () => user,

  getRefreshToken(): string | null {
    try {
      return sessionStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },

  set(tokens: { accessToken: string; refreshToken: string; user: User }) {
    accessToken = tokens.accessToken;
    user = tokens.user;
    try {
      sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    } catch {
      /* armazenamento indisponível: a sessão vale só até recarregar */
    }
    emit();
  },

  clear() {
    accessToken = null;
    user = null;
    try {
      sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      /* ignore */
    }
    emit();
  },

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  onExpired(fn: () => void) {
    expiredListeners.add(fn);
    return () => {
      expiredListeners.delete(fn);
    };
  },

  notifyExpired() {
    expiredListeners.forEach((l) => l());
  },
};
