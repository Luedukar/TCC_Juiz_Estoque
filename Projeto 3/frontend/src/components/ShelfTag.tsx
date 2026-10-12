import { fmtQty } from '../lib/format';
import type { Balance } from '../lib/types';
import { Barcode } from './Barcode';
import { STATUS_FILL, StatusBadge } from './StatusBadge';
import { StockGauge } from './StockGauge';

interface Props {
  product: Balance;
  /** Preenchido logo após registrar uma movimentação: mostra o saldo antes e depois. */
  change?: { before: number; after: number };
  /** Saldo vindo do cache local (sem conexão): pode estar desatualizado. */
  stale?: boolean;
}

/**
 * A etiqueta de gôndola: o produto identificado, o saldo em destaque e o código de barras.
 * A faixa lateral segue a cor da situação do estoque.
 */
export function ShelfTag({ product, change, stale }: Props) {
  return (
    <article
      aria-label={`Etiqueta de ${product.name}`}
      className="relative overflow-hidden rounded-[3px] border-2 border-ink bg-paper pl-6 pr-5 pt-5"
    >
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-3 ${STATUS_FILL[product.status]}`} />

      <h2 className="text-xl font-semibold leading-tight">{product.name}</h2>
      <p className="mt-1 font-mono text-sm text-ink-soft">{product.sku}</p>

      <div className="mt-4 flex items-baseline gap-2">
        <span key={product.currentStock} className="stamp text-6xl font-semibold leading-none tabular-nums">
          {fmtQty(product.currentStock)}
        </span>
        <span className="text-lg text-ink-soft">{product.unit.toLowerCase()} em estoque</span>
      </div>

      {change && (
        <p className="mt-2 text-sm font-medium tabular-nums">
          Saldo anterior: {fmtQty(change.before)}. Agora: {fmtQty(change.after)}.
        </p>
      )}
      {stale && (
        <p className="mt-2 text-sm font-medium text-caution">
          Saldo guardado neste aparelho; pode estar desatualizado até a conexão voltar.
        </p>
      )}

      <div className="mt-4 space-y-2">
        <StockGauge current={product.currentStock} safety={product.safetyStock} status={product.status} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 text-sm">
          <StatusBadge status={product.status} />
          <span className="tabular-nums text-ink-soft">Estoque de segurança: {fmtQty(product.safetyStock)}</span>
        </div>
      </div>

      <div className="-mx-5 mt-5 border-t border-dashed border-line px-5 py-4">
        <Barcode code={product.barcode} />
      </div>
    </article>
  );
}
