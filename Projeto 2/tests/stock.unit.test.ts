import { calculateStockBalances, StockLedgerEntry } from '../src/services/stock';

describe('calculateStockBalances', () => {
  it('soma entradas e subtrai saídas por produto', () => {
    const ledger: StockLedgerEntry[] = [
      { product_id: 1, movement_type: 'IN', quantity: 12 },
      { product_id: 1, movement_type: 'OUT', quantity: 4 },
      { product_id: 1, movement_type: 'ADJUSTMENT_IN', quantity: 2 },
      { product_id: 1, movement_type: 'REVERSAL_OUT', quantity: 1 },
      { product_id: 2, movement_type: 'IN', quantity: 3.5 },
      { product_id: 2, movement_type: 'REVERSAL_IN', quantity: 0.5 },
    ];

    expect(calculateStockBalances(ledger)).toEqual(new Map([[1, 9], [2, 4]]));
  });

  it('retorna mapa vazio sem lançamentos', () => {
    expect(calculateStockBalances([])).toEqual(new Map());
  });

  it('rejeita lançamentos com dados inválidos', () => {
    expect(() => calculateStockBalances([{ product_id: 0, movement_type: 'IN', quantity: 2 }])).toThrow(TypeError);
    expect(() => calculateStockBalances([{ product_id: 1, movement_type: 'OUT', quantity: -1 }])).toThrow(TypeError);
  });
});
