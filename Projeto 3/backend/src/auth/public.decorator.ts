import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Marca a rota como pública (sem JWT). Tudo é protegido por padrão. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
