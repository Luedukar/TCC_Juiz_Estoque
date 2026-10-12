export type StockMovementType = 'in' | 'out';

export class StockBalanceError extends Error {
  constructor(
    public readonly code: 'INVALID_QUANTITY' | 'INSUFFICIENT_STOCK',
    message: string
  ) {
    super(message);
    this.name = 'StockBalanceError';
  }
}

function toMilliunits(value: number): number {
  const scaled = value * 1000;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(value) || Math.abs(scaled - rounded) > 1e-6) {
    throw new StockBalanceError('INVALID_QUANTITY', 'Quantity must have at most 3 decimal places');
  }
  return rounded;
}

export function calculateNextBalance(
  currentQuantity: number,
  type: StockMovementType,
  quantity: number
): number {
  if (
    !Number.isFinite(currentQuantity) ||
    currentQuantity < 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000_000 ||
    (type !== 'in' && type !== 'out')
  ) {
    throw new StockBalanceError('INVALID_QUANTITY', 'Stock movement values are invalid');
  }

  const currentMilliunits = toMilliunits(currentQuantity);
  const movementMilliunits = toMilliunits(quantity);
  const nextMilliunits = type === 'in'
    ? currentMilliunits + movementMilliunits
    : currentMilliunits - movementMilliunits;

  if (nextMilliunits < 0) {
    throw new StockBalanceError('INSUFFICIENT_STOCK', 'Insufficient stock for this movement');
  }
  if (nextMilliunits > 99_999_999_999_999) {
    throw new StockBalanceError('INVALID_QUANTITY', 'Stock balance exceeds supported precision');
  }

  return nextMilliunits / 1000;
}
