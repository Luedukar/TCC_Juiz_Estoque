import type { AuthUser } from '../common/types';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      user?: AuthUser;
    }
  }
}

export {};
