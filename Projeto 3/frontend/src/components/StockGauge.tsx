import { fmtQty } from '../lib/format';
import type { StockStatus } from '../lib/types';
import { STATUS_FILL } from './StatusBadge';

interface Props {
  current: number;
  safety: number;
  status: StockStatus;
}

/** Barra de saldo com um traço marcando o estoque de segurança. */
export function StockGauge({ current, safety, status }: Props) {
  const max = Math.max(safety * 2, current, 1);
  const fill = Math.min(100, (Math.max(current, 0) / max) * 100);
  const mark = Math.min(100, (safety / max) * 100);

  return (
    <div
      role="img"
      aria-label={`Saldo ${fmtQty(current)}, estoque de segurança ${fmtQty(safety)}`}
      className="relative h-2.5 w-full bg-concrete-deep"
    >
      <div className={`h-full ${STATUS_FILL[status]}`} style={{ width: `${fill}%` }} />
      <div className="absolute -bottom-1 -top-1 w-0.5 bg-ink" style={{ left: `${mark}%` }} />
    </div>
  );
}
