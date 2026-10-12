import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../../src/common/app-error';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { IS_PUBLIC, Public } from '../../src/auth/public.decorator';
import { ROLES_KEY, Roles } from '../../src/auth/roles.decorator';
import { RolesGuard } from '../../src/auth/roles.guard';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-ok';
const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: 'HS256' } });

function ctx(req: any, meta: { handler?: object; cls?: object } = {}): ExecutionContext {
  const handler = function handler() {} as any;
  const cls = class Dummy {} as any;
  if (meta.handler) Object.entries(meta.handler).forEach(([k, v]) => Reflect.defineMetadata(k, v, handler));
  if (meta.cls) Object.entries(meta.cls).forEach(([k, v]) => Reflect.defineMetadata(k, v, cls));
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof AppError ? { status: e.getStatus(), code: e.code } : e;
  }
};

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(new Reflector(), jwt);

  it('rota pública passa sem token', async () => {
    await expect(guard.canActivate(ctx({ headers: {} }, { handler: { [IS_PUBLIC]: true } }))).resolves.toBe(true);
  });

  it('decorators @Public e @Roles gravam os metadados esperados', () => {
    class C {
      @Public()
      a() {}
      @Roles('GERENTE')
      b() {}
    }
    expect(Reflect.getMetadata(IS_PUBLIC, C.prototype.a)).toBe(true);
    expect(Reflect.getMetadata(ROLES_KEY, C.prototype.b)).toEqual(['GERENTE']);
  });

  it.each([
    ['sem cabeçalho', {}],
    ['esquema errado', { authorization: 'Basic abc' }],
    ['Bearer sem token', { authorization: 'Bearer' }],
  ])('rejeita %s -> 401 UNAUTHENTICATED', async (_n, headers) => {
    expect(await codeOf(guard.canActivate(ctx({ headers })))).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('aceita token válido (esquema "bearer" em qualquer caixa) e preenche req.user', async () => {
    const token = jwt.sign({ sub: 'u1', role: 'GERENTE' });
    const req: any = { headers: { authorization: `bEaReR ${token}` } };
    await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'u1', role: 'GERENTE' });
  });

  it('token expirado -> 401 TOKEN_EXPIRED (o frontend renova a sessão)', async () => {
    const token = jwt.sign({ sub: 'u1', role: 'GERENTE' }, { expiresIn: -10 });
    expect(await codeOf(guard.canActivate(ctx({ headers: { authorization: `Bearer ${token}` } })))).toEqual({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
  });

  it.each([
    ['lixo', 'abc.def.ghi'],
    ['assinado com outro segredo', new JwtService({ secret: 'outro-segredo-completamente-diferente-123' }).sign({ sub: 'u1', role: 'GERENTE' })],
    ['sem "sub"', jwt.sign({ role: 'GERENTE' })],
    ['sem perfil', jwt.sign({ sub: 'u1' })],
    ['perfil inexistente', jwt.sign({ sub: 'u1', role: 'ROOT' })],
  ])('token %s -> 401 INVALID_TOKEN', async (_n, token) => {
    expect(await codeOf(guard.canActivate(ctx({ headers: { authorization: `Bearer ${token}` } })))).toEqual({
      status: 401,
      code: 'INVALID_TOKEN',
    });
  });

  it('rejeita token "alg: none" (sem assinatura)', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', role: 'GERENTE' })}.`;
    expect(await codeOf(guard.canActivate(ctx({ headers: { authorization: `Bearer ${token}` } })))).toEqual({
      status: 401,
      code: 'INVALID_TOKEN',
    });
  });
});

describe('RolesGuard (RBAC)', () => {
  const guard = new RolesGuard(new Reflector());

  it('rota sem @Roles: qualquer usuário autenticado passa', () => {
    expect(guard.canActivate(ctx({ user: { id: 'u', role: 'ESTOQUISTA' } }))).toBe(true);
  });

  it('rota pública passa mesmo sem usuário', () => {
    expect(guard.canActivate(ctx({}, { handler: { [IS_PUBLIC]: true, [ROLES_KEY]: ['GERENTE'] } }))).toBe(true);
  });

  it('@Roles("GERENTE"): Gerente passa, Estoquista recebe 403', () => {
    const meta = { handler: { [ROLES_KEY]: ['GERENTE'] } };
    expect(guard.canActivate(ctx({ user: { id: 'u', role: 'GERENTE' } }, meta))).toBe(true);
    expect(() => guard.canActivate(ctx({ user: { id: 'u', role: 'ESTOQUISTA' } }, meta))).toThrow(AppError);
    try {
      guard.canActivate(ctx({ user: { id: 'u', role: 'ESTOQUISTA' } }, meta));
    } catch (e) {
      expect((e as AppError).getStatus()).toBe(403);
      expect((e as AppError).code).toBe('FORBIDDEN');
    }
  });

  it('sem usuário em rota restrita -> 403', () => {
    expect(() => guard.canActivate(ctx({}, { handler: { [ROLES_KEY]: ['GERENTE'] } }))).toThrow(AppError);
  });

  it('@Roles na classe vale para o método; lista vazia não restringe', () => {
    expect(() => guard.canActivate(ctx({ user: { id: 'u', role: 'ESTOQUISTA' } }, { cls: { [ROLES_KEY]: ['GERENTE'] } }))).toThrow(AppError);
    expect(guard.canActivate(ctx({ user: { id: 'u', role: 'ESTOQUISTA' } }, { handler: { [ROLES_KEY]: [] } }))).toBe(true);
  });
});
