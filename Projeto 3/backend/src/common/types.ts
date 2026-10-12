export type Role = 'GERENTE' | 'ESTOQUISTA';

export const ROLES: readonly Role[] = ['GERENTE', 'ESTOQUISTA'];

export interface AuthUser {
  id: string;
  role: Role;
}
