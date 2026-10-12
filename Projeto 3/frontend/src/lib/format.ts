import type { MovementType, StockStatus } from './types';

const qtyFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export const fmtQty = (n: number) => qtyFmt.format(n);
export const fmtMoney = (n: number) => moneyFmt.format(n);
export const fmtDateTime = (iso: string | number) => dateTimeFmt.format(new Date(iso));
export const fmtTime = (ms: number) => timeFmt.format(new Date(ms));

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Aceita "1,5", "1.5" e "1.234,5". Devolve null se não for um número positivo com até `decimals` casas. */
export function parseDecimal(input: string, decimals = 3): number | null {
  let t = input.trim();
  if (!t) return null;
  t = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const re = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(t)) return null;
  return Number(t);
}

export const REASON_LABEL: Record<string, string> = {
  COMPRA: 'Compra',
  VENDA: 'Venda',
  DEVOLUCAO_CLIENTE: 'Devolução de cliente',
  DEVOLUCAO_FORNECEDOR: 'Devolução ao fornecedor',
  PERDA_AVARIA: 'Perda ou avaria',
  AJUSTE_INVENTARIO: 'Ajuste de inventário',
  ESTORNO: 'Estorno',
  OUTRO: 'Outro',
};

export const REASONS: Record<MovementType, string[]> = {
  ENTRADA: ['COMPRA', 'DEVOLUCAO_CLIENTE', 'AJUSTE_INVENTARIO', 'OUTRO'],
  SAIDA: ['VENDA', 'DEVOLUCAO_FORNECEDOR', 'PERDA_AVARIA', 'AJUSTE_INVENTARIO', 'OUTRO'],
};

export const TYPE_LABEL: Record<MovementType, string> = { ENTRADA: 'Entrada', SAIDA: 'Saída' };

export const STATUS_LABEL: Record<StockStatus, string> = {
  ZERADO: 'Zerado',
  BAIXO: 'Abaixo do mínimo',
  OK: 'Em dia',
};

export function statusOf(currentStock: number, safetyStock: number): StockStatus {
  if (currentStock <= 0) return 'ZERADO';
  if (currentStock <= safetyStock) return 'BAIXO';
  return 'OK';
}
