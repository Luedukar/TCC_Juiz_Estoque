import { STATUS_LABEL } from '../lib/format';
import type { StockStatus } from '../lib/types';

export const STATUS_TEXT: Record<StockStatus, string> = {
  ZERADO: 'text-tag-red',
  BAIXO: 'text-caution',
  OK: 'text-shelf-green',
};

export const STATUS_FILL: Record<StockStatus, string> = {
  ZERADO: 'bg-tag-red-fill',
  BAIXO: 'bg-caution-fill',
  OK: 'bg-shelf-green-fill',
};

export const STATUS_BORDER: Record<StockStatus, string> = {
  ZERADO: 'border-tag-red-fill',
  BAIXO: 'border-caution-fill',
  OK: 'border-shelf-green-fill',
};

/** A situação sempre aparece em palavras; a cor só reforça. */
export function StatusBadge({ status }: { status: StockStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${STATUS_TEXT[status]}`}>
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 ${STATUS_FILL[status]}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}
