import type { Role } from '../common/types';

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Converte uma linha de v_kardex para o contrato da API.
 * Campos de custo só aparecem para GERENTE (RBAC).
 * Numéricos do PostgreSQL chegam como string; os limites do schema (numeric 14,3 / 12,2) cabem em double.
 */
export function toMovement(r: any, role: Role) {
  return {
    id: num(r.id),
    createdAt: (r.created_at as Date).toISOString(),
    productId: r.product_id as string,
    sku: r.sku as string,
    productName: r.product_name as string,
    type: r.type as 'ENTRADA' | 'SAIDA',
    reason: r.reason as string,
    quantity: num(r.quantity),
    signedQuantity: num(r.signed_quantity),
    balanceBefore: num(r.balance_before),
    balanceAfter: num(r.balance_after),
    ...(role === 'GERENTE' ? { unitCost: numOrNull(r.unit_cost) } : {}),
    documentRef: (r.document_ref as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    reversalOfId: numOrNull(r.reversal_of_id),
    reversedById: numOrNull(r.reversed_by_id),
    userName: r.user_name as string,
    supplierName: (r.supplier_name as string | null) ?? null,
  };
}

export function toBalance(r: any) {
  return {
    id: r.id as string,
    sku: r.sku as string,
    barcode: (r.barcode as string | null) ?? null,
    name: r.name as string,
    unit: r.unit as string,
    currentStock: num(r.current_stock),
    safetyStock: num(r.safety_stock),
    status: r.stock_status as 'ZERADO' | 'BAIXO' | 'OK',
  };
}
