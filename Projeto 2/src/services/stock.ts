export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'REVERSAL_IN' | 'REVERSAL_OUT';
export type StockLedgerEntry = { product_id: number | string; movement_type: StockMovementType; quantity: number | string };

const inboundTypes = new Set<StockMovementType>(['IN', 'ADJUSTMENT_IN', 'REVERSAL_IN']);

/** Soma o ledger imutável por produto. Tipos de entrada somam; tipos de saída subtraem. */
export function calculateStockBalances(entries: StockLedgerEntry[]): Map<number, number> {
  const balances = new Map<number, number>();
  for (const entry of entries) {
    const productId = Number(entry.product_id);
    const quantity = Number(entry.quantity);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isFinite(quantity) || quantity < 0) {
      throw new TypeError('Lançamento do ledger inválido.');
    }
    const sign = inboundTypes.has(entry.movement_type) ? 1 : -1;
    balances.set(productId, (balances.get(productId) ?? 0) + sign * quantity);
  }
  return balances;
}
