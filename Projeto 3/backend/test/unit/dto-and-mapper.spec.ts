import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto, RefreshDto } from '../../src/auth/auth.dto';
import {
  BalancesQueryDto,
  CreateMovementDto,
  KardexQueryDto,
  MovementsQueryDto,
  ReverseMovementDto,
} from '../../src/stock/stock.dto';
import { toBalance, toMovement } from '../../src/stock/stock.mapper';

async function errorsOf<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const errs = await validate(plainToInstance(cls, plain) as object, { whitelist: true, forbidNonWhitelisted: true });
  return errs.map((e) => e.property).sort();
}

const PID = '0b5f0c2e-6b1a-4c53-a5d1-2f7a4d2f9a10';

describe('CreateMovementDto', () => {
  const ok = { productId: PID, type: 'ENTRADA', quantity: 5 };

  it('aceita o mínimo válido e variações de leitor/SKU', async () => {
    expect(await errorsOf(CreateMovementDto, ok)).toEqual([]);
    expect(await errorsOf(CreateMovementDto, { barcode: '7891000100103', type: 'SAIDA', quantity: 0.001 })).toEqual([]);
    expect(await errorsOf(CreateMovementDto, { sku: 'CAFE-500', type: 'SAIDA', quantity: 12.345, reason: 'VENDA' })).toEqual([]);
  });

  it.each([
    ['quantidade zero', { quantity: 0 }, 'quantity'],
    ['quantidade negativa', { quantity: -1 }, 'quantity'],
    ['quantidade com 4 casas', { quantity: 1.2345 }, 'quantity'],
    ['quantidade NaN', { quantity: NaN }, 'quantity'],
    ['quantidade Infinity', { quantity: Infinity }, 'quantity'],
    ['quantidade texto', { quantity: '5' }, 'quantity'],
    ['quantidade acima do limite', { quantity: 100_000_000_000 }, 'quantity'],
    ['tipo inválido', { type: 'TRANSFERENCIA' }, 'type'],
    ['motivo inexistente', { reason: 'ROUBO' }, 'reason'],
    ['productId não UUID', { productId: '123' }, 'productId'],
    ['barcode curto', { productId: undefined, barcode: '123' }, 'barcode'],
    ['barcode com letras', { productId: undefined, barcode: '78910001001AB' }, 'barcode'],
    ['custo negativo', { unitCost: -1 }, 'unitCost'],
    ['custo com 3 casas', { unitCost: 1.234 }, 'unitCost'],
    ['documentRef muito longo', { documentRef: 'x'.repeat(61) }, 'documentRef'],
    ['notes muito longo', { notes: 'x'.repeat(501) }, 'notes'],
    ['supplierId inválido', { supplierId: 'abc' }, 'supplierId'],
  ])('rejeita %s', async (_n, patch, field) => {
    expect(await errorsOf(CreateMovementDto, { ...ok, ...patch })).toContain(field);
  });

  it('rejeita campos desconhecidos (whitelist estrita)', async () => {
    expect(await errorsOf(CreateMovementDto, { ...ok, currentStock: 9999 })).toContain('currentStock');
    expect(await errorsOf(CreateMovementDto, { ...ok, userId: 'x' })).toContain('userId');
  });

  it('remove espaços em barcode, sku, documentRef e notes (@Transform)', () => {
    const dto = plainToInstance(CreateMovementDto, { ...ok, barcode: ' 7891000100103 ', sku: ' A ', documentRef: ' NF ', notes: ' n ' });
    expect(dto).toMatchObject({ barcode: '7891000100103', sku: 'A', documentRef: 'NF', notes: 'n' });
  });
});

describe('DTOs de consulta e autenticação', () => {
  it('paginação: padrão 50/0, converte strings e respeita os limites', async () => {
    const q = plainToInstance(MovementsQueryDto, {});
    expect(q).toMatchObject({ limit: 50, offset: 0 });
    expect(plainToInstance(MovementsQueryDto, { limit: '20', offset: '40' })).toMatchObject({ limit: 20, offset: 40 });
    expect(await errorsOf(MovementsQueryDto, { limit: '0' })).toContain('limit');
    expect(await errorsOf(MovementsQueryDto, { limit: '201' })).toContain('limit');
    expect(await errorsOf(MovementsQueryDto, { offset: '-1' })).toContain('offset');
    expect(await errorsOf(MovementsQueryDto, { limit: '1.5' })).toContain('limit');
  });

  it('filtros de movimentação: tipo e datas ISO', async () => {
    expect(await errorsOf(MovementsQueryDto, { type: 'SAIDA', from: '2026-01-01', to: '2026-02-01T00:00:00Z', productId: PID })).toEqual([]);
    expect(await errorsOf(MovementsQueryDto, { type: 'X' })).toContain('type');
    expect(await errorsOf(MovementsQueryDto, { from: 'ontem' })).toContain('from');
  });

  it('Kardex exige productId UUID', async () => {
    expect(await errorsOf(KardexQueryDto, {})).toContain('productId');
    expect(await errorsOf(KardexQueryDto, { productId: 'x' })).toContain('productId');
    expect(await errorsOf(KardexQueryDto, { productId: PID })).toEqual([]);
  });

  it('saldos: barcode exato, situação restrita ao enum', async () => {
    expect(await errorsOf(BalancesQueryDto, { barcode: '7891000100103', status: 'BAIXO', q: 'cafe' })).toEqual([]);
    expect(await errorsOf(BalancesQueryDto, { barcode: '12' })).toContain('barcode');
    expect(await errorsOf(BalancesQueryDto, { status: 'MEIO' })).toContain('status');
    expect(await errorsOf(BalancesQueryDto, { q: 'x'.repeat(101) })).toContain('q');
  });

  it('estorno: observação opcional de até 500 caracteres', async () => {
    expect(await errorsOf(ReverseMovementDto, {})).toEqual([]);
    expect(await errorsOf(ReverseMovementDto, { notes: 'x'.repeat(501) })).toContain('notes');
  });

  it('login: e-mail válido (com trim) e senha obrigatória', async () => {
    expect(plainToInstance(LoginDto, { email: '  a@b.com ', password: 'x' }).email).toBe('a@b.com');
    expect(await errorsOf(LoginDto, { email: 'a@b.com', password: 'x' })).toEqual([]);
    expect(await errorsOf(LoginDto, { email: 'não-é-email', password: 'x' })).toContain('email');
    expect(await errorsOf(LoginDto, { email: 'a@b.com', password: '' })).toContain('password');
    expect(await errorsOf(LoginDto, { email: 'a@b.com', password: 'x'.repeat(129) })).toContain('password');
  });

  it('refresh: token entre 32 e 200 caracteres', async () => {
    expect(await errorsOf(RefreshDto, { refreshToken: 'x'.repeat(48) })).toEqual([]);
    expect(await errorsOf(RefreshDto, { refreshToken: 'curto' })).toContain('refreshToken');
    expect(await errorsOf(RefreshDto, { refreshToken: 'x'.repeat(201) })).toContain('refreshToken');
  });
});

describe('mappers de resposta (RBAC no contrato)', () => {
  const row = {
    id: '42',
    created_at: new Date('2026-10-09T18:00:00.000Z'),
    product_id: PID,
    sku: 'CAFE-500',
    product_name: 'Café 500g',
    type: 'ENTRADA',
    reason: 'COMPRA',
    quantity: '5.000',
    signed_quantity: '5.000',
    balance_before: '10.000',
    balance_after: '15.000',
    unit_cost: '9.50',
    document_ref: 'NF-1',
    notes: null,
    reversal_of_id: null,
    reversed_by_id: '43',
    user_name: 'Ana',
    supplier_name: null,
  };

  it('converte numéricos (string) para number e datas para ISO', () => {
    const m = toMovement(row, 'GERENTE');
    expect(m).toMatchObject({
      id: 42,
      createdAt: '2026-10-09T18:00:00.000Z',
      quantity: 5,
      signedQuantity: 5,
      balanceBefore: 10,
      balanceAfter: 15,
      reversedById: 43,
      reversalOfId: null,
      notes: null,
      supplierName: null,
    });
  });

  it('GERENTE vê unitCost; ESTOQUISTA não recebe nem a chave', () => {
    expect(toMovement(row, 'GERENTE')).toHaveProperty('unitCost', 9.5);
    expect(toMovement(row, 'ESTOQUISTA')).not.toHaveProperty('unitCost');
    expect(JSON.stringify(toMovement(row, 'ESTOQUISTA'))).not.toContain('9.5');
  });

  it('unitCost nulo vira null para o Gerente', () => {
    expect(toMovement({ ...row, unit_cost: null }, 'GERENTE').unitCost).toBeNull();
  });

  it('toBalance expõe saldo e situação, e nunca campos de custo', () => {
    const b = toBalance({ id: PID, sku: 'A', barcode: null, name: 'N', unit: 'UN', current_stock: '3.500', safety_stock: '10.000', stock_status: 'BAIXO', cost_price: '9.99' });
    expect(b).toEqual({ id: PID, sku: 'A', barcode: null, name: 'N', unit: 'UN', currentStock: 3.5, safetyStock: 10, status: 'BAIXO' });
    expect(b).not.toHaveProperty('costPrice');
  });
});
