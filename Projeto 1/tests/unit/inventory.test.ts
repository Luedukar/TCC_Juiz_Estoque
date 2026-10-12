import { describe, expect, it } from 'vitest';
import { calculateNextBalance, StockBalanceError } from '../../src/inventory';

describe('calculateNextBalance', () => {
  it('adds an incoming movement to the current balance', () => {
    expect(calculateNextBalance(8.25, 'in', 2.5)).toBe(10.75);
  });

  it('subtracts an outgoing movement to three-decimal precision', () => {
    expect(calculateNextBalance(10.125, 'out', 0.375)).toBe(9.75);
  });

  it('allows an outgoing movement to reduce the balance to zero', () => {
    expect(calculateNextBalance(1.25, 'out', 1.25)).toBe(0);
  });

  it('rejects outgoing movements that exceed available stock', () => {
    expect(() => calculateNextBalance(1, 'out', 1.001)).toThrowError(
      expect.objectContaining({ code: 'INSUFFICIENT_STOCK' })
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0001])(
    'rejects invalid movement quantity %s',
    (quantity) => {
      expect(() => calculateNextBalance(2, 'in', quantity)).toThrow(StockBalanceError);
    }
  );

  it('rejects a current balance that is not stored to thousandth precision', () => {
    expect(() => calculateNextBalance(1.0001, 'in', 1)).toThrow(StockBalanceError);
  });
});
