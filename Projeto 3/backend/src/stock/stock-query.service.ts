import { Injectable } from '@nestjs/common';
import type { Role } from '../common/types';
import { DatabaseService } from '../database/database.service';
import { BalancesQueryDto, KardexQueryDto, MovementsQueryDto } from './stock.dto';
import { toBalance, toMovement } from './stock.mapper';

/** Builder mínimo de WHERE parametrizado (nenhum valor do usuário entra na string SQL). */
class Where {
  private readonly clauses: string[] = [];
  readonly params: unknown[] = [];

  add(sql: string, value: unknown): void {
    this.params.push(value);
    this.clauses.push(sql.replaceAll('?', `$${this.params.length}`));
  }
  get sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

@Injectable()
export class StockQueryService {
  constructor(private readonly db: DatabaseService) {}

  /** Movimentações recentes de todos os produtos (mais novas primeiro). */
  async movements(role: Role, q: MovementsQueryDto) {
    const w = new Where();
    if (q.productId) w.add('product_id = ?', q.productId);
    if (q.type) w.add('type = ?', q.type);
    if (q.from) w.add('created_at >= ?', q.from);
    if (q.to) w.add('created_at < ?', q.to);
    return this.page(role, w, 'DESC', q.limit, q.offset);
  }

  /** Extrato (Kardex) de um produto, em ordem cronológica com saldo corrente. */
  async kardex(role: Role, q: KardexQueryDto) {
    const w = new Where();
    w.add('product_id = ?', q.productId);
    if (q.from) w.add('created_at >= ?', q.from);
    if (q.to) w.add('created_at < ?', q.to);
    return this.page(role, w, 'ASC', q.limit, q.offset);
  }

  async balances(q: BalancesQueryDto) {
    const w = new Where();
    if (q.barcode) w.add('barcode = ?', q.barcode);
    if (q.sku) w.add('sku = ?', q.sku);
    if (q.status) w.add('stock_status = ?', q.status);
    if (q.q) w.add('(name ILIKE ? OR sku::text ILIKE ? OR barcode ILIKE ?)', `%${q.q.replace(/[\\%_]/g, '\\$&')}%`);

    const params = [...w.params, q.limit, q.offset];
    const { rows } = await this.db.query(
      `SELECT * FROM v_product_balances ${w.sql}
       ORDER BY name, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data: rows.map(toBalance), limit: q.limit, offset: q.offset };
  }

  /** Itens abaixo (ou no) estoque de segurança, do mais crítico ao menos crítico. */
  async alerts() {
    const { rows } = await this.db.query(`SELECT * FROM v_low_stock LIMIT 500`);
    const data = rows.map((r) => ({
      ...toBalance(r),
      shortfall: Number(r.shortfall),
      preferredSupplier: (r.preferred_supplier as string | null) ?? null,
    }));
    const zerado = data.filter((d) => d.status === 'ZERADO').length;
    return { data, summary: { zerado, baixo: data.length - zerado, total: data.length } };
  }

  private async page(role: Role, w: Where, dir: 'ASC' | 'DESC', limit: number, offset: number) {
    const params = [...w.params, limit, offset];
    const { rows } = await this.db.query(
      `SELECT * FROM v_kardex ${w.sql}
       ORDER BY created_at ${dir}, id ${dir} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { data: rows.map((r) => toMovement(r, role)), limit, offset };
  }
}
