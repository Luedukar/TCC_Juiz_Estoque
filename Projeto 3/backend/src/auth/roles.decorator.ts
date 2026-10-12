import { SetMetadata } from '@nestjs/common';
import type { Role } from '../common/types';

export const ROLES_KEY = 'roles';
/** Restringe a rota aos perfis informados. Sem o decorator, qualquer usuário autenticado acessa. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
